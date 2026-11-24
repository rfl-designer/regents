# Nenhuma mensagem no limbo

Toda mensagem que envolve Agentes termina em resposta ou em falha visível com motivo, e o seu Andamento (o passo atual e há quanto tempo ele roda) fica sempre à vista. Escolhemos isso acima de velocidade porque o problema que o Shearim existe para resolver é mandar uma mensagem e descobrir muito depois que nada aconteceu; esperar não é o problema, o limbo é.

## Consequências

- Processo morto (queda, encerramento, reinício do servidor) vira falha na hora, sem esperar prazo.
- Processo vivo sem sinal de progresso tem um prazo por passo: "modelo escrevendo" tem 2 minutos no v1, e cada tool futura terá o seu (uma suíte de testes pode levar 30). O critério é tempo sem progresso, nunca tempo total.
- Uma falha é tentada de novo uma vez sozinha; depois aparece com o motivo, um botão "Tentar de novo" e um push para quem mandou a mensagem. Conta no limite não é falha: a execução passa para a Chave do Workspace, à vista (ADR 0002); sem Chave, a mensagem espera na fila com o motivo e a hora da volta à vista.
- Num Canal com Agentes, até a decisão de que nenhum Agente precisa agir é um Desfecho visível.
