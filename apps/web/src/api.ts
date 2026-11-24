import type {
  ApiError,
  ApproveJoinRequestDto,
  ChannelDto,
  JoinRequestAdminDto,
  JoinRequestDto,
  MeDto,
  MessageDto,
  MyJoinRequestDto,
  SendMessageInput,
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

const post = { method: "POST" } as const;

export const api = {
  me: () => call<MeDto>("/api/me"),
  myJoinRequest: () => call<MyJoinRequestDto>("/api/join-request"),
  requestToJoin: () => call<JoinRequestDto>("/api/join-request", post),
  joinRequests: () => call<JoinRequestAdminDto[]>("/api/join-requests"),
  approve: (id: string) => call<ApproveJoinRequestDto>(`/api/join-requests/${id}/approve`, post),
  refuse: (id: string) => call<JoinRequestAdminDto>(`/api/join-requests/${id}/refuse`, post),
  channels: () => call<ChannelDto[]>("/api/channels"),
  messages: (channelId: string) => call<MessageDto[]>(`/api/channels/${channelId}/messages`),
  send: (channelId: string, input: SendMessageInput) =>
    call<MessageDto>(`/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
};
