import type { DmDto, MeDto } from "@shearim/contracts";
import { Conversation } from "./ChannelView";

/** Como a DM se chama para quem a vê: os nomes das outras pessoas. */
export function dmTitle(dm: DmDto, me: MeDto) {
  const others = dm.participants.filter((p) => !(p.kind === "member" && p.id === me.id));
  return others.map((p) => p.displayName).join(", ") || me.displayName;
}

export function DmView({ dm, me }: { dm: DmDto; me: MeDto }) {
  const title = dmTitle(dm, me);
  return (
    <main className="channel">
      <header className="channel-header">
        <div className="row">
          <h1 className="channel-name">{title}</h1>
          <span className="hint">{dm.kind === "group" ? `DM em grupo · ${dm.participants.length} pessoas` : "DM"}</span>
        </div>
      </header>
      <Conversation conversationId={dm.id} label={title} />
    </main>
  );
}
