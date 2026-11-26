# A Wiki é consultada por índice e leitura, sem vetor

O Agente consulta uma Wiki como uma pessoa consulta uma wiki: lê o índice, escolhe as páginas e as abre pela Ferramenta de leitura da Wiki. Não há embeddings, busca vetorial nem pedaços de texto soltos. A Wiki segue o padrão LLM Wiki de Andrej Karpathy: as Fontes brutas não mudam, as páginas em markdown são mantidas pela Articuladora com links entre elas, e um índice diz o que cada página cobre. Escolhemos isso porque a Wiki já chega destilada e organizada por tema. Para algumas centenas de páginas, ler o índice acerta mais do que a similaridade vetorial. Além disso, o erro fica à vista: o Andamento mostra quais páginas o Agente abriu, e a resposta cita a página que usou.

## Considered Options

- **RAG com vetor sobre as Fontes brutas**: a transcrição repete, divaga e espalha uma ideia por várias aulas. A busca devolve um trecho parecido, não o método do curso, e erra em silêncio. Precisa de um provedor de embeddings (a Anthropic não tem um próprio), com chave e custo a mais, de pgvector e de reindexar a cada mudança.
- **Fonte inteira no contexto**: um curso transcrito tem de 100 mil a 500 mil tokens. Cada execução monta o contexto do zero (ADR 0006) e é paga pela Conta de quem escreveu.
- **Vetor e índice juntos desde o início**: tem o custo dos dois sem um caso real que o índice não resolva.

## Consequências

- A qualidade da consulta depende da qualidade da Sincronização: um índice ruim dá uma consulta ruim. Por isso a Sincronização inclui o lint (contradições e páginas sem link).
- Se uma Wiki crescer além do que o índice cobre bem, o próximo passo é a busca textual do Postgres, ainda sem vetor. Vetor só entra com um caso real em que o índice e a busca textual falham.
- Uma consulta à Wiki é uma leitura comum: conta no teto de Ferramentas e no orçamento do Agente.
- A Wiki tem alcance próprio (pública ou uma lista de Membros), e não herda o alcance de uma conversa de origem, como a Memória (ADR 0012), porque ela nasce das Fontes, e não de uma conversa. Ela só é lida numa resposta em que o autor e todos os Membros que veem a conversa estão no alcance dela. Num Canal público, onde todo Membro vê a conversa, só uma Wiki pública é lida. A conferência é feita em código, como a da Memória.
