# O app fica num container próprio, atrás do sidecar em userspace

O sidecar do Tailscale roda no modo padrão da imagem (userspace), sem `/dev/net/tun`, sem capabilities (`cap_drop: ALL`) e sem `ports:`. O app do Shearim roda num container separado na rede interna do compose, e o Tailscale Serve faz proxy para `http://app:3000`. Escolhemos isso porque o desvio que a pesquisa encontrou (`docs/research/identidade-da-tailnet-no-docker.md`, seção 3.2) só existe quando o app divide o namespace de rede com o sidecar (`network_mode: service:tailscale`). Em userspace, o netstack entrega uma conexão para uma porta que o Serve não intercepta no `127.0.0.1` do próprio sidecar. Com o app fora desse namespace, não há nada escutando ali, e o único caminho de um peer até o app é o Serve, que limpa e reescreve os headers de identidade. É o desenho que o agentes.chat usa no perfil `tailscale` do compose dele. Esse desenho também roda em Mac (Docker Desktop, OrbStack, Colima), o que permite instalar o Shearim em qualquer computador do time.

## Considered Options

- **Modo kernel com o app em `127.0.0.1` no namespace do sidecar**: fecha o desvio pelo kernel, mas exige `/dev/net/tun`, `net_admin` e `net_raw`, e não tem garantia em Docker no Mac.
- **Userspace com o app num Unix socket**: tira a porta TCP, mas exige um volume compartilhado. Ninguém verificou se o WebSocket do Bun funciona por Unix socket, e desde a 1.98.9 os alvos Unix do Serve são restritos a root.
- **Userspace com uma ACL que só libera `tcp:443`**: o desvio continua existindo e quem o fecha é a política da tailnet. Basta um grant amplo para ele reabrir sem ninguém perceber.

## Consequências

- Qualquer container ligado à rede interna do compose consegue falar com `app:3000` e forjar os headers. Essa rede tem só o sidecar, o app, o Postgres e o backup, e nenhum `docker-compose.override.yml` pode ligar outro serviço a ela.
- O app continua montando o socket do tailscaled num volume comum e roda sem root, para chamar o `whois` pelo IP do `X-Forwarded-For` (ADR 0007).
- Uma porta do sidecar que escuta no loopback (o `/healthz` em `127.0.0.1:9002`) fica alcançável por um peer através do netstack. Ali só pode haver o que não tem segredo.
- A imagem do Tailscale fica fixada em 1.104.4 ou mais nova (boletins TS-2026-016 e TS-2026-017). O nó usa `tag:shearim`, assim uma requisição feita de dentro da instalação não herda a identidade do dono do nó.
