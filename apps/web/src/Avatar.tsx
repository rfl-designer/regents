/** Foto da pessoa (a da tailnet), ou a inicial do nome quando não há foto. */
export function Avatar({ name, src }: { name: string; src: string | null }) {
  if (src) return <img className="avatar" src={src} alt="" />;
  return (
    <div className="avatar" aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}
