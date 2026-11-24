# A aprovação termina a execução, e quem faz a escrita é o Shearim

Quando um Agente pede uma escrita, a execução cria o Pedido de aprovação com a ação exata (a Ferramenta e os argumentos) e termina: o processo sai, e o Andamento fica em "esperando aprovação de <autor>". Quando o autor aprova, o próprio Shearim executa a ação guardada, sem passar pelo modelo, e começa uma execução nova com o contexto remontado e o resultado da ação, para o Agente terminar a resposta. A recusa, com um motivo opcional do autor, também começa a execução de continuação, com a recusa no lugar do resultado, para o Agente propor outra coisa ou encerrar. A expiração (24 h) não continua: o Andamento termina em "a aprovação expirou". O autor não edita a ação: aprova ou recusa. Escolhemos isso porque a espera pode levar horas, e o ADR 0006 já não guarda sessão: um processo vivo esperando seguraria uma das vagas de execução da Conta do autor e ~250 MB de memória.

## Considered Options

- **Processo vivo até a decisão**: a resposta continua no mesmo turno do modelo, mas cada pedido pendente ocupa uma vaga da Conta e memória do host, e um reinício do servidor perde a espera.
- **`--resume` da sessão depois da decisão**, como no `agentes-chat`: o ADR 0006 descartou a sessão do Claude Code, e pela Chave não há sessão para retomar.

## Consequências

- A ação guardada é a que o autor viu. O Shearim executa exatamente ela, e o modelo não pode trocar os argumentos depois da aprovação.
- Uma resposta com várias escritas vira uma sequência de execuções, uma por Pedido de aprovação.
- Um pedido esperando decisão não é limbo (ADR 0003): está à vista, tem dono e expira.
- A continuação lê o contexto na hora em que começa (ADR 0006). Se a conversa andou durante a espera, o Agente vê as mensagens novas.
- As Ferramentas ficam ligadas no `claude -p` das respostas. O roteamento continua com `--tools ""` (ADR 0009).
