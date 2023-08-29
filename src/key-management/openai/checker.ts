import axios, { AxiosError } from "axios";
import { logger } from "../../logger";
import type { OpenAIKey, OpenAIKeyProvider } from "./provider";
import type { OpenAIModelFamily } from "../models";

/** Minimum time in between any two key checks. */
const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
/**
 * Minimum time in between checks for a given key. Because we can no longer
 * read quota usage, there is little reason to check a single key more often
 * than this.
 **/
const KEY_CHECK_PERIOD = 60 * 60 * 1000; // 1 hour

const POST_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const GET_MODELS_URL = "https://api.openai.com/v1/models";
const GET_ORGANIZATIONS_URL = "https://api.openai.com/v1/organizations";

type GetModelsResponse = {
  data: [{ id: string }];
};

type GetOrganizationsResponse = {
  data: [{ id: string; is_default: boolean }];
};

type OpenAIError = {
  error: { type: string; code: string; param: unknown; message: string };
};

type CloneFn = typeof OpenAIKeyProvider.prototype.clone;
type UpdateFn = typeof OpenAIKeyProvider.prototype.update;

export class OpenAIKeyChecker {
  private readonly keys: OpenAIKey[];
  private log = logger.child({ module: "key-checker", service: "openai" });
  private timeout?: NodeJS.Timeout;
  private cloneKey: CloneFn;
  private updateKey: UpdateFn;
  private lastCheck = 0;

  constructor(keys: OpenAIKey[], cloneFn: CloneFn, updateKey: UpdateFn) {
    this.keys = keys;
    this.cloneKey = cloneFn;
    this.updateKey = updateKey;
  }

  public start() {
    this.log.info("Starting key checker...");
    this.scheduleNextCheck();
  }

  public stop() {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
  }

  /**
   * Schedules the next check. If there are still keys yet to be checked, it
   * will schedule a check immediately for the next unchecked key. Otherwise,
   * it will schedule a check for the least recently checked key, respecting
   * the minimum check interval.
   **/
  public scheduleNextCheck() {
    const enabledKeys = this.keys.filter((key) => !key.isDisabled);
    clearTimeout(this.timeout);

    if (enabledKeys.length === 0) {
      this.log.warn("All keys are disabled. Key checker stopping.");
      return;
    }

    // Perform startup checks for any keys that haven't been checked yet.
    const uncheckedKeys = enabledKeys.filter((key) => !key.lastChecked);
    if (uncheckedKeys.length > 0) {
      // Check up to 12 keys at once to speed up startup.
      const keysToCheck = uncheckedKeys.slice(0, 12);

      this.log.info(
        {
          key: keysToCheck.map((key) => key.hash),
          remaining: uncheckedKeys.length - keysToCheck.length,
        },
        "Scheduling initial checks for key batch."
      );
      this.timeout = setTimeout(async () => {
        const promises = keysToCheck.map((key) => this.checkKey(key));
        try {
          await Promise.all(promises);
        } catch (error) {
          this.log.error({ error }, "Error checking one or more keys.");
        }
        this.scheduleNextCheck();
      }, 250);
      return;
    }

    // Schedule the next check for the oldest key.
    const oldestKey = enabledKeys.reduce((oldest, key) =>
      key.lastChecked < oldest.lastChecked ? key : oldest
    );

    // Don't check any individual key too often.
    // Don't check anything at all at a rate faster than once per 3 seconds.
    const nextCheck = Math.max(
      oldestKey.lastChecked + KEY_CHECK_PERIOD,
      this.lastCheck + MIN_CHECK_INTERVAL
    );

    this.log.debug(
      { key: oldestKey.hash, nextCheck: new Date(nextCheck) },
      "Scheduling next check."
    );

    const delay = nextCheck - Date.now();
    this.timeout = setTimeout(() => this.checkKey(oldestKey), delay);
  }

  private async checkKey(key: OpenAIKey) {
    // It's possible this key might have been disabled while we were waiting
    // for the next check.
    if (key.isDisabled) {
      this.log.warn({ key: key.hash }, "Skipping check for disabled key.");
      this.scheduleNextCheck();
      return;
    }

    this.log.debug({ key: key.hash }, "Checking key...");
    let isInitialCheck = !key.lastChecked;
    try {
      // We only need to check for provisioned models on the initial check.
      if (isInitialCheck) {
        const [provisionedModels, livenessTest] = await Promise.all([
          this.getProvisionedModels(key),
          this.testLiveness(key),
          this.maybeCreateOrganizationClones(key),
        ]);
        const updates = {
          modelFamilies: provisionedModels,
          isTrial: livenessTest.rateLimit <= 250,
          softLimit: 0,
          hardLimit: 0,
          systemHardLimit: 0,
        };
        this.updateKey(key.hash, updates);
      } else {
        // Provisioned models don't change, so we don't need to check them again
        const [_livenessTest] = await Promise.all([this.testLiveness(key)]);
        const updates = { softLimit: 0, hardLimit: 0, systemHardLimit: 0 };
        this.updateKey(key.hash, updates);
      }
      this.log.info(
        { key: key.hash, models: key.modelFamilies },
        "Key check complete."
      );
    } catch (error) {
      // touch the key so we don't check it again for a while
      this.updateKey(key.hash, {});
      this.handleAxiosError(key, error as AxiosError);
    }

    this.lastCheck = Date.now();
    // Only enqueue the next check if this wasn't a startup check, since those
    // are batched together elsewhere.
    if (!isInitialCheck) {
      // this.scheduleNextCheck();
    }
  }

  private async getProvisionedModels(
    key: OpenAIKey
  ): Promise<OpenAIModelFamily[]> {
    const opts = { headers: OpenAIKeyChecker.getHeaders(key) };
    const { data } = await axios.get<GetModelsResponse>(GET_MODELS_URL, opts);
    const models = data.data;

    const families: OpenAIModelFamily[] = [];
    if (models.some(({ id }) => id.startsWith("gpt-3.5-turbo"))) {
      families.push("turbo");
    }

    if (models.some(({ id }) => id.startsWith("gpt-4"))) {
      families.push("gpt4");
    }

    if (models.some(({ id }) => id.startsWith("gpt-4-32k"))) {
      families.push("gpt4-32k");
    }

    // We want to update the key's model families here, but we don't want to
    // update its `lastChecked` timestamp because we need to let the liveness
    // check run before we can consider the key checked.

    // Need to use `find` here because keys are cloned from the pool.
    const keyFromPool = this.keys.find((k) => k.hash === key.hash)!;
    this.updateKey(key.hash, {
      modelFamilies: families,
      lastChecked: keyFromPool.lastChecked,
    });
    return families;
  }

  private async maybeCreateOrganizationClones(key: OpenAIKey) {
    if (key.organizationId) return; // already cloned
    const opts = { headers: { Authorization: `Bearer ${key.key}` } };
    const { data } = await axios.get<GetOrganizationsResponse>(
      GET_ORGANIZATIONS_URL,
      opts
    );
    const organizations = data.data;
    if (organizations.length <= 1) return undefined;

    this.log.info(
      { parent: key.hash, organizations: organizations.map((org) => org.id) },
      "Key is associated with multiple organizations; cloning key for each organization."
    );

    const defaultOrg = organizations.find(({ is_default }) => is_default);
    const ids = organizations
      .filter(({ is_default }) => !is_default)
      .map(({ id }) => id);
    this.updateKey(key.hash, { organizationId: defaultOrg?.id });
    this.cloneKey(key.hash, ids);
  }

  private handleAxiosError(key: OpenAIKey, error: AxiosError) {
    if (error.response && OpenAIKeyChecker.errorIsOpenAIError(error)) {
      const { status, data } = error.response;
      if (status === 401) {
        this.log.warn(
          { key: key.hash, error: data },
          "Key is invalid or revoked. Disabling key."
        );
        this.updateKey(key.hash, {
          isDisabled: true,
          isRevoked: true,
          modelFamilies: ["turbo"],
        });
      } else if (status === 429) {
        switch (data.error.type) {
          case "insufficient_quota":
          case "access_terminated":
          case "billing_not_active":
            const isOverQuota = data.error.type === "insufficient_quota";
            const isRevoked = !isOverQuota;
            const modelFamilies: OpenAIModelFamily[] = isRevoked
              ? ["turbo"]
              : key.modelFamilies;
            this.log.warn(
              { key: key.hash, rateLimitType: data.error.type, error: data },
              "Key returned a non-transient 429 error. Disabling key."
            );
            this.updateKey(key.hash, {
              isDisabled: true,
              isRevoked,
              isOverQuota,
              modelFamilies,
            });
            break;
          case "requests":
            // Trial keys have extremely low requests-per-minute limits and we
            // can often hit them just while checking the key, so we need to
            // retry the check later to know if the key has quota remaining.
            this.log.warn(
              { key: key.hash, error: data },
              "Key is currently rate limited, so its liveness cannot be checked. Retrying in fifteen seconds."
            );
            // To trigger a shorter than usual delay before the next check, we
            // will set its `lastChecked` to (NOW - (KEY_CHECK_PERIOD - 15s)).
            // This will cause the usual key check scheduling logic to schedule
            // the next check in 15 seconds. This also prevents the key from
            // holding up startup checks for other keys.
            const fifteenSeconds = 15 * 1000;
            const next = Date.now() - (KEY_CHECK_PERIOD - fifteenSeconds);
            this.updateKey(key.hash, { lastChecked: next });
            break;
          case "tokens":
            // Hitting a token rate limit, even on a trial key, actually implies
            // that the key is valid and can generate completions, so we will
            // treat this as effectively a successful `testLiveness` call.
            this.log.info(
              { key: key.hash },
              "Key is currently `tokens` rate limited; assuming it is operational."
            );
            this.updateKey(key.hash, { lastChecked: Date.now() });
            break;
          default:
            this.log.error(
              { key: key.hash, rateLimitType: data.error.type, error: data },
              "Encountered unexpected rate limit error class while checking key. This may indicate a change in the API; please report this."
            );
            // We don't know what this error means, so we just let the key
            // through and maybe it will fail when someone tries to use it.
            this.updateKey(key.hash, { lastChecked: Date.now() });
        }
      } else {
        this.log.error(
          { key: key.hash, status, error: data },
          "Encountered unexpected error status while checking key. This may indicate a change in the API; please report this."
        );
        this.updateKey(key.hash, { lastChecked: Date.now() });
      }
      return;
    }
    this.log.error(
      { key: key.hash, error: error.message },
      "Network error while checking key; trying this key again in a minute."
    );
    const oneMinute = 60 * 1000;
    const next = Date.now() - (KEY_CHECK_PERIOD - oneMinute);
    this.updateKey(key.hash, { lastChecked: next });
  }

  /**
   * Tests whether the key is valid and has quota remaining. The request we send
   * is actually not valid, but keys which are revoked or out of quota will fail
   * with a 401 or 429 error instead of the expected 400 Bad Request error.
   * This lets us avoid test keys without spending any quota.
   *
   * We use the rate limit header to determine whether it's a trial key.
   */
  private async testLiveness(key: OpenAIKey): Promise<{ rateLimit: number }> {
    const payload = {
      model: "gpt-3.5-turbo",
      max_tokens: -1,
      messages: [{ role: "user", content: "" }],
    };
    const { headers, data } = await axios.post<OpenAIError>(
      POST_CHAT_COMPLETIONS_URL,
      payload,
      {
        headers: OpenAIKeyChecker.getHeaders(key),
        validateStatus: (status) => status === 400,
      }
    );
    const rateLimitHeader = headers["x-ratelimit-limit-requests"];
    const rateLimit = parseInt(rateLimitHeader) || 3500; // trials have 200

    // invalid_request_error is the expected error
    if (data.error.type !== "invalid_request_error") {
      this.log.warn(
        { key: key.hash, error: data },
        "Unexpected 400 error class while checking key; assuming key is valid, but this may indicate a change in the API."
      );
    }
    return { rateLimit };
  }

  static errorIsOpenAIError(
    error: AxiosError
  ): error is AxiosError<OpenAIError> {
    const data = error.response?.data as any;
    return data?.error?.type;
  }

  static getHeaders(key: OpenAIKey) {
    const headers = {
      Authorization: `Bearer ${key.key}`,
      ...(key.organizationId && { "OpenAI-Organization": key.organizationId }),
    };
    return headers;
  }
}
