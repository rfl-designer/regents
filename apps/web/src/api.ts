import type {
  AccountDto,
  AgentDto,
  AgentGitHubDto,
  AgentSkillDto,
  AgentToolDto,
  ApiError,
  ApprovalRequestDto,
  ApproveJoinRequestDto,
  ChannelDto,
  ChannelSettingsDto,
  ConnectorDto,
  ConnectorLoginDto,
  CreateAgentInput,
  CreateChannelInput,
  CreateConnectorInput,
  CreateConnectorLoginInput,
  CreateSkillInput,
  DeviceDto,
  DmDto,
  ExecutionDto,
  FollowedThreadDto,
  GitHubDto,
  GitHubInstallDto,
  GitHubManifestDto,
  ImportSkillResultDto,
  InstallationDto,
  JoinRequestAdminDto,
  JoinRequestDto,
  MeDto,
  MemberRole,
  MemberSummaryDto,
  MemoryItemDto,
  MessageDto,
  MyConnectorDto,
  MyJoinRequestDto,
  OutcomeDto,
  PushKeyDto,
  PushSubscriptionInput,
  SendMessageInput,
  SetPresenceInput,
  SkillDto,
  SubmitAccountCodeInput,
  UnreadDto,
  UnreadMessagesDto,
  UpdateAgentInput,
  UpdateChannelSettingsInput,
  UpdateProfileInput,
  UpdateSkillInput,
  WorkspaceContextDto,
  WorkspaceKeyDto,
} from "@regents/contracts";

/** Falha de uma chamada à API, já com o que a tela precisa para explicar. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
  ) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

/** A mensagem que o servidor mandou com o erro (`{ error, message }`), ou `fallback`. */
export function messageOf(err: unknown, fallback: string) {
  const body = err instanceof ApiFailure ? err.body : null;
  return body && "message" in body && typeof body.message === "string" ? body.message : fallback;
}

/** O servidor não respondeu (Tailscale desligado, servidor fora do ar). */
export class Offline extends Error {}

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const post = { method: "POST" } as const;

export const api = {
  pushKey: () => call<PushKeyDto>("/api/push/key"),
  putPushSubscription: (deviceId: string, input: PushSubscriptionInput) =>
    call<void>(`/api/push/subscriptions/${deviceId}`, json("PUT", input)),
  devices: () => call<DeviceDto[]>("/api/devices"),
  removeDevice: (id: string) => call<void>(`/api/devices/${id}`, { method: "DELETE" }),
  setPresence: (input: SetPresenceInput) => call<void>("/api/presence", json("PUT", input)),
  me: () => call<MeDto>("/api/me"),
  installation: () => call<InstallationDto>("/api/installation"),
  updateProfile: (input: UpdateProfileInput) => call<MeDto>("/api/me", json("PATCH", input)),
  members: () => call<MemberSummaryDto[]>("/api/members"),
  /** Só Admin: torna Admin ou rebaixa (o último Admin não: 409 `last_admin`). */
  setMemberRole: (memberId: string, role: MemberRole) =>
    call<MemberSummaryDto>(`/api/members/${memberId}`, json("PATCH", { role })),
  /** Só Admin: remove o Membro do Workspace. */
  removeMember: (memberId: string) => call<void>(`/api/members/${memberId}`, { method: "DELETE" }),
  myJoinRequest: () => call<MyJoinRequestDto>("/api/join-request"),
  requestToJoin: () => call<JoinRequestDto>("/api/join-request", post),
  joinRequests: () => call<JoinRequestAdminDto[]>("/api/join-requests"),
  approve: (id: string) => call<ApproveJoinRequestDto>(`/api/join-requests/${id}/approve`, post),
  refuse: (id: string) => call<JoinRequestAdminDto>(`/api/join-requests/${id}/refuse`, post),
  channels: () => call<ChannelDto[]>("/api/channels"),
  channel: (channelId: string) => call<ChannelDto>(`/api/channels/${channelId}`),
  createChannel: (input: CreateChannelInput) => call<ChannelDto>("/api/channels", json("POST", input)),
  joinChannel: (channelId: string) => call<ChannelDto>(`/api/channels/${channelId}/join`, json("POST")),
  addParticipant: (channelId: string, memberId: string) =>
    call<ChannelDto>(`/api/channels/${channelId}/participants`, json("POST", { memberId })),
  channelSettings: () => call<ChannelSettingsDto[]>("/api/channel-settings"),
  updateChannelSettings: (channelId: string, input: UpdateChannelSettingsInput) =>
    call<ChannelSettingsDto>(`/api/channel-settings/${channelId}`, json("PATCH", input)),
  dms: () => call<DmDto[]>("/api/dms"),
  /** Abre a DM com essas pessoas, ou devolve a que já existe com elas. */
  openDm: (memberIds: string[]) => call<DmDto>("/api/dms", json("POST", { memberIds })),
  /** Abre a DM de quem chama com esse Agente, ou devolve a que já existe. */
  openAgentDm: (agentId: string) => call<DmDto>("/api/dms", json("POST", { memberIds: [], agentId })),
  /** Mensagens de qualquer conversa (Canal ou DM). */
  messages: (conversationId: string) => call<MessageDto[]>(`/api/conversations/${conversationId}/messages`),
  send: (conversationId: string, input: SendMessageInput) =>
    call<MessageDto>(`/api/conversations/${conversationId}/messages`, json("POST", input)),
  /** As Threads que quem pede segue (de todas as conversas). */
  followedThreads: () => call<FollowedThreadDto[]>("/api/threads/followed"),
  /** As não-lidas de quem pede, em todas as conversas dele. */
  unread: () => call<UnreadDto>("/api/unread"),
  /** As não-lidas numa conversa, na ordem de exibição (a primeira é onde ela abre). */
  conversationUnread: (conversationId: string) =>
    call<UnreadMessagesDto>(`/api/conversations/${conversationId}/unread`),
  /** Marca o que apareceu na tela. */
  markRead: (conversationId: string, messageIds: string[]) =>
    call<UnreadDto>(`/api/conversations/${conversationId}/reads`, json("POST", { messageIds })),
  account: {
    get: () => call<AccountDto>("/api/account"),
    notNow: () => call<AccountDto>("/api/account/not-now", post),
    startLinking: () => call<AccountDto>("/api/account/linking", post),
    submitCode: (input: SubmitAccountCodeInput) => call<AccountDto>("/api/account/linking/code", json("POST", input)),
    confirm: () => call<AccountDto>("/api/account/linking/confirm", post),
    cancelLinking: () => call<AccountDto>("/api/account/linking", { method: "DELETE" }),
    unlink: () => call<AccountDto>("/api/account", { method: "DELETE" }),
  },
  /** O Andamento do que ainda não virou resposta numa conversa. */
  executions: (conversationId: string) => call<ExecutionDto[]>(`/api/conversations/${conversationId}/executions`),
  /** "Tentar de novo" de uma falha (só quem escreveu a mensagem). */
  retryExecution: (conversationId: string, executionId: string) =>
    call<ExecutionDto>(`/api/conversations/${conversationId}/executions/${executionId}/retry`, post),
  /** Cancela o que a mensagem ainda tem em andamento (só quem escreveu). */
  cancelMessage: (conversationId: string, messageId: string) =>
    call<ExecutionDto[]>(`/api/conversations/${conversationId}/messages/${messageId}/cancel`, post),
  /** Os Pedidos de aprovação de uma conversa (todos que a veem). */
  approvals: (conversationId: string) => call<ApprovalRequestDto[]>(`/api/conversations/${conversationId}/approvals`),
  /** Aprovar ou recusar um Pedido (só o autor da mensagem de origem). */
  approveRequest: (conversationId: string, approvalId: string) =>
    call<ApprovalRequestDto>(`/api/conversations/${conversationId}/approvals/${approvalId}/approve`, post),
  rejectRequest: (conversationId: string, approvalId: string, reason: string) =>
    call<ApprovalRequestDto>(
      `/api/conversations/${conversationId}/approvals/${approvalId}/reject`,
      json("POST", reason.trim() ? { reason } : {}),
    ),
  /** A Memória da Conversa (com as Threads): ativos e arquivados, do mais novo ao mais velho. */
  memory: (conversationId: string) => call<MemoryItemDto[]>(`/api/conversations/${conversationId}/memory`),
  /** Desfaz um item da Memória (qualquer escopo): ele fica arquivado. Devolve o item. */
  undoMemory: (itemId: string) => call<MemoryItemDto>(`/api/memory/${itemId}/undo`, { method: "POST" }),
  /** Corrige um item da Memória: devolve a versão nova (a anterior fica arquivada e chega por evento). */
  correctMemory: (itemId: string, text: string) =>
    call<MemoryItemDto>(`/api/memory/${itemId}/correct`, json("POST", { text })),
  /** Só o Admin: promove um item de Canal público ao Workspace. Devolve a versão do Workspace. */
  promoteMemory: (itemId: string) => call<MemoryItemDto>(`/api/memory/${itemId}/promote`, { method: "POST" }),
  /** A Memória do Workspace (todo Membro vê): ativos e arquivados, do mais novo ao mais velho. */
  workspaceMemory: () => call<MemoryItemDto[]>("/api/workspace-memory"),
  /** Só o Admin: escreve um item direto na Memória do Workspace. */
  writeWorkspaceMemory: (text: string) => call<MemoryItemDto>("/api/workspace-memory", json("POST", { text })),
  /** Os Desfechos da Articuladora numa conversa (uma DM não tem). */
  outcomes: (conversationId: string) => call<OutcomeDto[]>(`/api/conversations/${conversationId}/outcomes`),
  updateAgent: (agentId: string, input: UpdateAgentInput) =>
    call<AgentDto>(`/api/agents/${agentId}`, json("PATCH", input)),
  agents: () => call<AgentDto[]>("/api/agents"),
  /** A Memória do Agente: só os itens cuja conversa de origem quem olha vê (#65). */
  agentMemory: (agentId: string) => call<MemoryItemDto[]>(`/api/agents/${agentId}/memory`),
  /** Só o Admin: a Memória do Agente sai junto; as mensagens e a Memória da Conversa ficam. */
  deleteAgent: (agentId: string) => call<void>(`/api/agents/${agentId}`, { method: "DELETE" }),
  agentTools: (agentId: string) => call<AgentToolDto[]>(`/api/agents/${agentId}/tools`),
  setAgentTool: (agentId: string, toolId: string, granted: boolean) =>
    call<AgentToolDto[]>(`/api/agents/${agentId}/tools/${toolId}`, { method: granted ? "PUT" : "DELETE" }),
  createAgent: (input: CreateAgentInput) => call<AgentDto>("/api/agents", json("POST", input)),
  addAgent: (channelId: string, agentId: string) =>
    call<ChannelDto>(`/api/channels/${channelId}/agents`, json("POST", { agentId })),
  skills: () => call<SkillDto[]>("/api/skills"),
  createSkill: (input: CreateSkillInput) => call<SkillDto>("/api/skills", json("POST", input)),
  updateSkill: (skillId: string, input: UpdateSkillInput) =>
    call<SkillDto>(`/api/skills/${skillId}`, json("PATCH", input)),
  deleteSkill: (skillId: string) => call<void>(`/api/skills/${skillId}`, { method: "DELETE" }),
  importSkill: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return call<ImportSkillResultDto>("/api/skills/import", { method: "POST", body });
  },
  /**
   * A pasta da skill: cada arquivo com o caminho a partir da pasta escolhida. Só o `SKILL.md` vai
   * com o texto; dos outros vai só o caminho (o servidor os lista como ignorados), para que scripts
   * e assets grandes não pesem no limite.
   */
  importSkillFolder: (files: File[]) => {
    const body = new FormData();
    for (const file of files) {
      const path = file.webkitRelativePath || file.name;
      if (/(^|\/)SKILL\.md$/i.test(path)) body.append("files", file, path);
      else body.append("files", path);
    }
    return call<ImportSkillResultDto>("/api/skills/import", { method: "POST", body });
  },
  agentSkills: (agentId: string) => call<AgentSkillDto[]>(`/api/agents/${agentId}/skills`),
  setAgentSkill: (agentId: string, skillId: string, active: boolean) =>
    call<AgentSkillDto[]>(`/api/agents/${agentId}/skills/${skillId}`, { method: active ? "PUT" : "DELETE" }),
  workspaceContext: () => call<WorkspaceContextDto>("/api/workspace-context"),
  setWorkspaceContext: (context: string) =>
    call<WorkspaceContextDto>("/api/workspace-context", json("PUT", { context })),
  connectors: () => call<ConnectorDto[]>("/api/connectors"),
  /** Abrir o Conector relê o catálogo do servidor. */
  connector: (id: string) => call<ConnectorDto>(`/api/connectors/${id}`),
  createConnector: (input: CreateConnectorInput) => call<ConnectorDto>("/api/connectors", json("POST", input)),
  setConnectorToken: (id: string, token: string) =>
    call<ConnectorDto>(`/api/connectors/${id}/credential`, json("PUT", { token })),
  /** Adicionar pelo login do servidor: o navegador vai ao login e volta com o Conector gravado. */
  connectorLogin: (input: CreateConnectorLoginInput) =>
    call<ConnectorLoginDto>("/api/connectors/login", json("POST", input)),
  /** Religar a credencial do Workspace pelo login do servidor. */
  connectorRelogin: (id: string, origin: string) =>
    call<ConnectorLoginDto>(`/api/connectors/${id}/credential/login`, json("POST", { origin })),
  removeConnector: (id: string) => call<void>(`/api/connectors/${id}`, { method: "DELETE" }),
  /** Perfil › Conectores: as credenciais do próprio Membro nos Conectores de cada Membro. */
  myConnectors: () => call<MyConnectorDto[]>("/api/me/connectors"),
  connectMine: (id: string, token: string) =>
    call<MyConnectorDto>(`/api/me/connectors/${id}/credential`, json("PUT", { token })),
  /** Ligar a minha pelo login do servidor. */
  connectMineLogin: (id: string, origin: string) =>
    call<ConnectorLoginDto>(`/api/me/connectors/${id}/credential/login`, json("POST", { origin })),
  disconnectMine: (id: string) => call<void>(`/api/me/connectors/${id}/credential`, { method: "DELETE" }),
  workspaceKey: () => call<WorkspaceKeyDto>("/api/workspace-key"),
  setWorkspaceKey: (apiKey: string) => call<WorkspaceKeyDto>("/api/workspace-key", json("PUT", { apiKey })),
  github: () => call<GitHubDto>("/api/github"),
  githubManifest: (origin: string, organization: string) =>
    call<GitHubManifestDto>("/api/github/manifest", json("POST", { origin, organization: organization || undefined })),
  githubInstall: () => call<GitHubInstallDto>("/api/github/installation", { method: "POST" }),
  agentGitHub: (agentId: string) => call<AgentGitHubDto>(`/api/agents/${agentId}/github`),
  setAgentGitHub: (agentId: string, repositories: string[] | null) =>
    call<AgentGitHubDto>(`/api/agents/${agentId}/github`, json("PUT", { repositories })),
};
