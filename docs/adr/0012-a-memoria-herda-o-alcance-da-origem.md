# A Memória herda o alcance da origem

Todo item de Memória guarda a conversa de onde nasceu e só entra numa resposta cujo alcance inclui essa conversa. O alcance é o mesmo das Ferramentas do Workspace: a interseção do que podem ver o autor e todos os participantes da conversa da resposta. Isso vale também para a Memória do Agente, que não acompanha o Agente pelo Workspace. O que nasceu num Canal privado ou numa DM não aparece fora do alcance dela, nem pelo nome. A conferência é feita em código, ao montar o contexto, e não por instrução ao modelo. Escolhemos isso porque um Agente que lembra em #geral o que ouviu em #financeiro vira um jeito de ler Canais alheios, e "ninguém vê mais do que já via" é a regra que as Ferramentas já seguem.

## Considered Options

- **A Memória do Agente acompanha o Agente**: é mais útil, porque uma lição aprendida num lugar vale em todos, mas leva o que foi dito num Canal privado para qualquer conversa em que o Agente estiver.
- **Guardar tudo e pedir ao modelo que não revele o que é de outro alcance**: o `agentes-chat` filtra em SQL, mas deixa algumas brechas (o texto de uma regra em respostas a outras pessoas) dependendo só de uma linha no prompt. Prompt não é fronteira.

## Consequências

- O Agente parece "esquecer" fora do alcance: uma correção dada numa DM só vale naquela DM, e um fato de #financeiro não existe em #geral.
- Numa DM só entre o autor e o Agente, o alcance é tudo o que o autor vê, então ali aparece a Memória de todos os Canais do autor.
- O alcance é calculado na hora da resposta, a partir da origem, e não congelado quando o item nasce: se alguém sai de um Canal privado, deixa de alcançar a Memória dele.
- Uma correção, uma substituição ou uma promoção nunca alarga o alcance. Por isso a Memória do Workspace só nasce da Memória da Conversa de um Canal público ou da mão de um Admin.
- A lista de Memória que um Membro vê, Admin inclusive, segue a mesma regra.
