import type { DmDto, MeDto } from "@shearim/contracts";
import { Conversation } from "./ChannelView";

/** Como a DM se chama para quem a vê: os nomes das outras pessoas. */
export function dmTitle(dm: DmDto, me: MeDto) {
  const others = dm.participants.filter((p) => !(p.kind === "member" && p.id === me.id));
  return others.map((p) => p.displayName).join(", ") || me.displayName;
}

function dmHint(dm: DmDto) {
  if (dm.kind === "group") return `DM em grupo · ${dm.participants.length} pessoas`;
  // Numa DM com Agente, ele responde a cada mensagem; numa entre pessoas, só por Menção.
  return dm.participants.some((p) => p.kind === "agent") ? "DM com Agente · responde a cada mensagem" : "DM";
}

export function DmView({ dm, me, focus }: { dm: DmDto; me: MeDto; focus?: string }) {
  const title = dmTitle(dm, me);
  return (
    <main className="channel">
      <header className="channel-header">
        <div className="row">
          <h1 className="channel-name">{title}</h1>
          <span className="hint">{dmHint(dm)}</span>
        </div>
      </header>
      <Conversation conversationId={dm.id} label={title} me={me} focus={focus} />
    </main>
  );
}
