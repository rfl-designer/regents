# A Sincronização é autorizada pelo clique, é tudo ou nada e gera versões

A Sincronização de uma Wiki não cria Pedido de aprovação. O clique do Admin em "Sincronizar" autoriza a Sincronização inteira: criar e ligar páginas, atualizar o índice e apontar contradições. A Wiki só muda quando a Sincronização termina. Se ela falhar ou for cancelada, a Wiki fica na versão anterior. Cada Sincronização concluída gera uma versão, e o Admin pode voltar à anterior. Escolhemos isso porque uma Sincronização escreve dezenas de páginas de uma vez. Aprovar página por página não é viável, e a volta à versão anterior desfaz um erro sem travar o fluxo. Como a Memória (ADR 0013), a Sincronização é um trabalho do próprio Shearim, e não uma escrita de Ferramenta durante uma resposta. Por isso a regra "toda escrita de Ferramenta passa por Pedido de aprovação" continua sem exceção: os Agentes que respondem em conversas só leem a Wiki, nunca a escrevem.

## Considered Options

- **Relatório para aprovar antes de publicar**: protege contra uma destilação ruim, mas põe uma segunda espera em cada Sincronização, e o Admin, que já pediu a Sincronização, aprovaria quase sempre sem ler.
- **Pedido de aprovação por página**: dezenas de pedidos por Sincronização.
- **Publicar a cada Fonte processada**: uma falha no meio deixa uma Wiki pela metade, e os Agentes consultam uma base inconsistente sem saber.

## Consequências

- A Sincronização tem um estado visível na tela da Wiki: em curso (Fonte 3 de 7), concluída com o relatório das páginas criadas e alteradas, ou falha com o motivo. O Admin pode cancelar. Nunca fica no limbo (ADR 0003).
- A Sincronização é paga pela Conta do Admin que clicou, com a Chave do Workspace como reserva quando a Conta está no limite, e conta no orçamento da Articuladora.
- A Habilidade de Sincronização e as regras da Wiki são do Shearim e fixas, como as instruções da Articuladora. Assim, as Wikis de Workspaces diferentes têm a mesma forma, e a consulta dos Agentes é previsível.
