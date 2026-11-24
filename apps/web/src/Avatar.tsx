/** Avatar: pessoa é um círculo; Agente é um quadrado arredondado com o selo ✦ (protótipo A). */
export function Avatar({ name, agent = false, photo }: { name: string; agent?: boolean; photo?: string | null }) {
  return (
    <div className={agent ? "avatar agent" : "avatar"} aria-hidden>
      {photo ? <img src={photo} alt="" /> : name.slice(0, 1).toUpperCase()}
    </div>
  );
}
