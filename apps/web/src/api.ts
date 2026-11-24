import type {
  AccountDto,
  ApiError,
  ChannelDto,
  MeDto,
  MessageDto,
  SendMessageInput,
  SubmitAccountCodeInput,
} from "@shearim/contracts";

/** Falha de uma chamada à API, já com o que a tela precisa para explicar. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
  ) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

/** O servidor não respondeu (Tailscale desligado, servidor fora do ar). */
export class Offline extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new Offline();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiFailure(res.status, body);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => call<MeDto>("/api/me"),
  channels: () => call<ChannelDto[]>("/api/channels"),
  messages: (channelId: string) => call<MessageDto[]>(`/api/channels/${channelId}/messages`),
  send: (channelId: string, input: SendMessageInput) =>
    call<MessageDto>(`/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  account: {
    get: () => call<AccountDto>("/api/account"),
    notNow: () => call<AccountDto>("/api/account/not-now", { method: "POST" }),
    startLinking: () => call<AccountDto>("/api/account/linking", { method: "POST" }),
    submitCode: (input: SubmitAccountCodeInput) =>
      call<AccountDto>("/api/account/linking/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    confirm: () => call<AccountDto>("/api/account/linking/confirm", { method: "POST" }),
    cancelLinking: () => call<AccountDto>("/api/account/linking", { method: "DELETE" }),
    unlink: () => call<AccountDto>("/api/account", { method: "DELETE" }),
  },
};
