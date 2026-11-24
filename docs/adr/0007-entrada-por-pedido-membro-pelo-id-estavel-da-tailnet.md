# Entrada por Pedido, Membro pelo ID estável da tailnet

Ninguém vira Membro só por chegar pelo Tailscale Serve com identidade. Quem chega pela primeira vez cria um Pedido de entrada, e um Admin aprova ou recusa. A exceção é o primeiro a chegar numa instalação vazia, que entra direto como Admin. O Membro fica amarrado ao `UserProfile.ID` que a LocalAPI `whois` devolve; o login e o nome dos headers do Serve servem só para exibição. Escolhemos a aprovação porque o Serve entrega headers válidos também a usuários de outras tailnets que aceitaram um share do nó, e um clique por pessoa custa pouco num Workspace de 4 a 6 pessoas. Escolhemos o ID porque o próprio Tailscale descreve o login como "for display purposes only" (pesquisa em `docs/research/identidade-da-tailnet-no-docker.md`).

## Considered Options

- **Toda pessoa que chega pelo Serve vira Membro, com a ACL da tailnet como portão**: é mais simples, mas qualquer pessoa que recebesse um share do nó entraria sem ninguém perceber.
- **Convite prévio por login**: o login só aparece quando a pessoa chega, e ele não serve de chave.
- **Amarrar o Membro ao header `Tailscale-User-Login`**: dispensa o socket e a LocalAPI, mas uma troca de e-mail no provedor transformaria o Membro em outra pessoa.

## Consequências

- O app monta o socket do tailscaled, roda sem root (assim tem só leitura na LocalAPI) e chama o `whois` pelo IP do `X-Forwarded-For` uma vez por sessão ou por conexão WebSocket. A fronteira de confiança continua a mesma dos headers: o desvio do Serve precisa estar fechado.
- O pedido de uma pessoa de outra tailnet chega ao Admin marcado como tal, pelo `Node.Hostinfo.ShareeNode` do `whois`, que é o servidor de controle que define.
- Uma requisição sem identidade (nó com tag, Funnel, desvio) recebe uma página estática com o motivo e não vira pedido.
- Aparelho compartilhado fala como o dono dele. Não há perfis dentro do Shearim; a tela mostra sempre como quem a pessoa está.
- Outro `UserProfile.ID` é outra pessoa, com um Pedido de entrada novo.
- Quem foi removido e é aprovado de novo volta como o mesmo Membro, com o histórico, mas fora dos Canais privados e das DMs em grupo.
