import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = new URL("../src/", import.meta.url);

export const codeSource = readFileSync(new URL("Code.js", source), "utf8");

export type Result = { ok: true } | { ok: false; code: string };
type Json = Record<string, unknown>;

export interface FetchReply {
  status?: number;
  body?: unknown;
  rawBody?: string;
  throws?: boolean;
}

export const GOOD_PROPERTIES: Record<string, string> = {
  EMAIL_TO: "owner@example.com",
  TURNSTILE_SITE_KEY: "site-key",
  TURNSTILE_SECRET_KEY: "secret-key",
  TURNSTILE_ACTION: "inquiry",
  TURNSTILE_HOSTNAMES: "Abc123.example.net, other.example.net",
};

export const VALID_PAYLOAD = {
  name: "Taro",
  email: "visitor@example.org",
  subject: "Hello",
  message: "First line\nSecond line",
  turnstileToken: "token-1",
  website: "",
};

export const SITEVERIFY_OK = {
  success: true,
  action: "inquiry",
  hostname: "abc123.example.net",
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Load src/Code.js into a fresh vm context backed by mocked GAS services. */
export function createGas(
  properties: Record<string, string> = GOOD_PROPERTIES,
  now = "2026-10-09T12:34:56.000Z",
) {
  const store = new Map(Object.entries(properties));
  const fetchCalls: { url: string; options: Json }[] = [];
  const mails: Json[] = [];
  const logs: string[] = [];
  const state = {
    lockHeld: false,
    lockAvailable: true,
    lockReleases: 0,
    lockHeldDuringExternal: false,
    mailQuota: 100,
    mailThrows: false,
    storeThrows: false,
    now,
    fetchReplies: [] as FetchReply[],
    fetchDefault: { body: SITEVERIFY_OK } as FetchReply,
    onTryLock: undefined as undefined | (() => void),
    onFetch: undefined as undefined | (() => void),
    onCounterRead: undefined as undefined | (() => void),
  };

  const outputs: Json[] = [];
  const makeOutput = (kind: string, html: string) => {
    const output: Json = { kind, html, title: "", meta: {} };
    outputs.push(output);
    const chain = {
      setTitle(title: string) {
        output.title = title;
        return chain;
      },
      addMetaTag(name: string, content: string) {
        (output.meta as Json)[name] = content;
        return chain;
      },
    };
    return chain;
  };

  const properties_ = {
    getProperty(key: string) {
      if (state.storeThrows && key.startsWith("RL_")) {
        throw new Error("store failure");
      }
      if (key.startsWith("RL_") && state.lockHeld) {
        state.onCounterRead?.();
      }
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setProperty(key: string, value: string) {
      if (key.startsWith("RL_") && !state.lockHeld) {
        throw new Error("counter written without the script lock");
      }
      store.set(key, value);
    },
  };

  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(state.now);
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: forwarding Date args
        super(...(args as [any]));
      }
    }
  }

  const sandbox = {
    console: { log: (line: string) => logs.push(String(line)) },
    Date: FakeDate,
    HtmlService: {
      createHtmlOutput: (html: string) => makeOutput("inline", html),
      createTemplateFromFile: (name: string) => {
        const template: Json = {
          evaluate: () => makeOutput(name, JSON.stringify(template)),
        };
        return template;
      },
    },
    PropertiesService: { getScriptProperties: () => properties_ },
    LockService: {
      getScriptLock: () => ({
        tryLock() {
          state.onTryLock?.();
          if (!state.lockAvailable || state.lockHeld) {
            return false;
          }
          state.lockHeld = true;
          return true;
        },
        releaseLock() {
          state.lockHeld = false;
          state.lockReleases += 1;
        },
      }),
    },
    UrlFetchApp: {
      fetch(url: string, options: Json) {
        if (state.lockHeld) {
          state.lockHeldDuringExternal = true;
        }
        fetchCalls.push({ url, options: clone(options) });
        state.onFetch?.();
        const reply = state.fetchReplies.shift() ?? state.fetchDefault;
        if (reply.throws) {
          throw new Error("fetch failure");
        }
        return {
          getResponseCode: () => reply.status ?? 200,
          getContentText: () => reply.rawBody ?? JSON.stringify(reply.body),
        };
      },
    },
    MailApp: {
      getRemainingDailyQuota: () => state.mailQuota,
      sendEmail(options: Json) {
        if (state.lockHeld) {
          state.lockHeldDuringExternal = true;
        }
        if (state.mailThrows) {
          throw new Error("mail failure");
        }
        mails.push(clone(options));
      },
    },
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(codeSource, context, { filename: "Code.js" });
  const global = context as unknown as {
    submitInquiry(payload: unknown): Result;
    doGet(): unknown;
  } & Record<string, unknown>;

  return {
    // Clone like the RPC layer so results are plain, realm-independent data.
    submit: (payload: unknown): Result =>
      clone(global.submitInquiry(payload)) as Result,
    global,
    store,
    fetchCalls,
    mails,
    outputs,
    logs,
    state,
  };
}
