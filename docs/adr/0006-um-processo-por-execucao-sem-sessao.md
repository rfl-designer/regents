# Um processo por execução, sem sessão do Claude Code

Toda chamada a modelo que passa pela Conta de um Membro (o roteamento da Articuladora, a resposta dela, cada delegado, cada Menção) roda num `claude -p` novo, sem sessão guardada (`--no-session-persistence`), que termina ao fim da resposta. O Shearim monta o contexto inteiro a cada chamada (preâmbulo, Contexto do Workspace, instruções do Agente, Instruções do Canal, quem é quem e as últimas N mensagens), lido na hora em que a execução começa. Escolhemos isso porque o contexto já é do Shearim: uma sessão do Claude Code guardaria uma segunda cópia dele, que pode divergir da conversa, e um mesmo Membro fala com Agentes de instruções diferentes.

## Considered Options

- **Um processo vivo por Membro** (`--input-format stream-json`): funciona e economiza ~0,2–0,9 s por mensagem, mas ocupa ~250 MB residentes por Membro ativo, mistura instruções de Agentes diferentes no mesmo processo e precisa de reciclagem.
- **`--resume` por conversa**: mantém o contexto entre processos, mas depende do transcript na pasta da Conta, duplica o histórico que o Shearim já tem e amarra a execução ao Membro que abriu a sessão.

## Consequências

- Cada execução custa ~1 s de spawn a mais. O Desfecho e a bolha "escrevendo" cobrem essa espera.
- Um reinício do servidor não retoma o turno interrompido: a execução vira falha "o servidor reiniciou" e segue o ADR 0003 (uma nova tentativa automática, do zero). O texto parcial não é guardado.
- O número de processos é o número de execuções em curso, limitado por Conta (2 respostas, mais o roteamento) e no host (8, ajustável na instalação). Esses tetos existem por causa da cota da assinatura, do lock de renovação da pasta da Conta e da memória.
- O processo é encerrado com `SIGINT`, e só depois com `SIGTERM` e `SIGKILL`, porque matar à força no meio de uma renovação pode deslogar a pasta inteira (anthropics/claude-code#102985).
