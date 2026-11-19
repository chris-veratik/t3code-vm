// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- macOS provider credentials stay in the desktop process and native Keychain.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { localVmHome } from "@t3tools/ssh/localVm";

export type SubscriptionRequest = "codex" | "codex-refresh" | "claude";
type CodexTokens = { accessToken: string; chatgptAccountId: string; chatgptPlanType?: string };
export class CredentialError extends Schema.TaggedError<CredentialError>()(
  "LocalVmCredentialError",
  { message: Schema.String },
) {}
export const isCredentialError = Schema.is(CredentialError);
const codexSignIn = "Sign in to Codex with ChatGPT on your Mac, then retry.";
const claudeSetup = "Save a Claude setup token in Settings → Environments → Local VMs on your Mac.";

async function macCodex() {
  for (const file of [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    NodePath.join(NodeOS.homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ]) {
    if (
      await NodeFSP.access(file, NodeFSP.constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return file;
  }
  throw new CredentialError({ message: "Install Codex and sign in with ChatGPT on your Mac." });
}

async function readMacCodex(refreshToken: boolean) {
  const child = NodeChildProcess.spawn(await macCodex(), ["app-server"], {
    cwd: NodeOS.homedir(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = NodeReadline.createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill(), 12_000);
  child.stdin.on("error", () => {});
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  const exited = new Promise<never>((_, reject) => {
    child.once("error", () => reject(new CredentialError({ message: codexSignIn })));
    child.once("close", () => reject(new CredentialError({ message: codexSignIn })));
  });
  const read = async () => {
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "t3_local_vm", version: "1" },
        capabilities: { experimentalApi: true },
      },
    });
    for await (const line of lines) {
      const msg = JSON.parse(line);
      if (msg.id === 1 && msg.result) {
        send({ method: "initialized" });
        send({ id: 2, method: "getAuthStatus", params: { includeToken: true, refreshToken } });
      } else if (msg.id === 2) {
        if (msg.result?.authMethod !== "chatgpt" || typeof msg.result.authToken !== "string")
          throw new CredentialError({ message: codexSignIn });
        const accessToken: string = msg.result.authToken;
        const payload = JSON.parse(
          Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString(),
        );
        const claims = payload["https://api.openai.com/auth"];
        if (
          typeof claims?.chatgpt_account_id !== "string" ||
          !claims.chatgpt_account_id ||
          typeof payload.exp !== "number"
        )
          throw new CredentialError({ message: codexSignIn });
        const tokens: CodexTokens = { accessToken, chatgptAccountId: claims.chatgpt_account_id };
        if (typeof claims.chatgpt_plan_type === "string")
          tokens.chatgptPlanType = claims.chatgpt_plan_type;
        return { tokens, expires: payload.exp * 1000 };
      } else if (msg.id === 1 && msg.error) throw new CredentialError({ message: codexSignIn });
    }
    throw new CredentialError({ message: codexSignIn });
  };
  try {
    return await Promise.race([read(), exited]);
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

export function createCodexSubscription(read: typeof readMacCodex = readMacCodex) {
  let pending: { force: boolean; result: Promise<CodexTokens> } | undefined;
  let lastRefresh: { tokens: CodexTokens; until: number } | undefined;

  async function fetchCodex(force: boolean) {
    if (force && lastRefresh && Date.now() < lastRefresh.until) return lastRefresh.tokens;
    let result = await read(force);
    if (!force && result.expires < Date.now() + 60_000) {
      result = await read(true);
      force = true;
    }
    if (result.expires <= Date.now()) throw new CredentialError({ message: codexSignIn });
    if (force)
      lastRefresh = { tokens: result.tokens, until: Math.min(Date.now() + 30_000, result.expires) };
    return result.tokens;
  }

  async function codexTokens(force: boolean, previous: string | null): Promise<CodexTokens> {
    // A forced refresh must follow a concurrent ordinary read. All guests share one refresh owner.
    if (pending && force && !pending.force) {
      await pending.result.catch(() => {});
      return codexTokens(true, previous);
    }
    pending ??= {
      force,
      result: fetchCodex(force).finally(() => {
        pending = undefined;
      }),
    };
    const tokens = await pending.result;
    if (previous && tokens.chatgptAccountId !== previous)
      throw new CredentialError({
        message:
          "The Mac is signed in to a different ChatGPT workspace. Reconnect the original account.",
      });
    return tokens;
  }

  return {
    issue: codexTokens,
    clear: () => {
      lastRefresh = undefined;
    },
  };
}
const codexSubscription = createCodexSubscription();

async function claudeEntry() {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  const profile = NodeCrypto.createHash("sha256")
    .update(NodePath.resolve(localVmHome()))
    .digest("hex")
    .slice(0, 16);
  return new AsyncEntry("T3 Code Local VM subscriptions", "claude-" + profile);
}

export const macCredentials = {
  async issue(op: SubscriptionRequest, previous: string | null) {
    if (op !== "claude") return codexSubscription.issue(op === "codex-refresh", previous);
    const value = await (await claudeEntry()).getPassword();
    if (!value) throw new CredentialError({ message: claudeSetup });
    return value;
  },
  async configureClaude() {
    const script =
      'text returned of (display dialog "Run claude setup-token in Terminal on this Mac, then paste the token here. T3 Code will save it in your Mac Keychain." default answer "" with hidden answer buttons {"Cancel", "Save"} default button "Save" with title "Claude subscription for local VMs")';
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      "/usr/bin/osascript",
      ["-e", script],
      {
        maxBuffer: 16_384,
      },
    ).catch((err: { stderr?: string }) => {
      if (err.stderr?.includes("(-128)")) return { stdout: "" };
      throw new CredentialError({ message: "The Mac could not open the Claude setup dialog." });
    });
    const token = stdout.trim();
    if (!token) return false;
    if (!/^sk-ant-oat[\w-]{15,}$/.test(token))
      throw new CredentialError({
        message: "Enter the subscription token printed by claude setup-token on your Mac.",
      });
    await (await claudeEntry()).setPassword(token);
    return true;
  },
  async forgetClaude() {
    await (await claudeEntry()).deleteCredential();
  },
  clearCache: codexSubscription.clear,
};
