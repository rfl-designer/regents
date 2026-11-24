# O Desfecho pela Conta sai do `--json-schema` do `claude -p`

O roteamento da Articuladora devolve uma decisão estruturada (`responder | delegar | nenhum`, até 2 delegados com uma frase cada, e um motivo). Pela Conta, essa decisão sai do próprio `claude -p`: o Shearim passa o JSON Schema do Desfecho em `--json-schema` e lê a resposta em `result.structured_output`. Na porta de modelo, o pedido leva `outputSchema` e o fim traz `done.structured`. Pela Chave, o mesmo schema vai como saída estruturada da Messages API (`output_config.format`). O schema é um só, nos dois cérebros, e é do Shearim. Escolhemos isso porque o Claude Code já valida a resposta contra o schema e tenta de novo sozinho quando ela não bate, e o Shearim não precisa fazer parse do texto.

## Considered Options

- **Pedir JSON no prompt e fazer parse do texto**: funciona em qualquer versão, mas o modelo às vezes devolve texto em volta ou um JSON inválido, e a validação e a nova tentativa ficariam com o Shearim.
- **Uma tool `desfecho` com o resultado nos argumentos**: é o jeito clássico de forçar estrutura, mas as tools ficam desligadas no `claude -p` (`--tools ""`, ADR 0006), e os modelos atuais recusam `tool_choice` forçado.

## Consequências

- Sem `structured_output` num `result` de sucesso, e com `terminal_reason: "structured_output_retry_exhausted"`, a execução é falha comum ("o modelo não devolveu a decisão no formato pedido"): entra na nova tentativa automática (ADR 0003).
- O formato de `structured_output` depende da versão do Claude Code, que fica fixada na imagem. O `fake-claude` devolve `structuredOutput` no fim roteirizado.
- **Não medido**: o `--json-schema` junto com `--tools ""`. O smoke manual do #22 pela Conta confere isso antes de fixar a versão. Se não funcionar, o caminho é o parse do texto, sem mudar a porta.
