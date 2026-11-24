# Uma instalação, um Workspace

Cada instalação do Shearim (um `docker-compose` exposto numa tailnet) serve exatamente um Workspace, e o isolamento entre grupos de pessoas é feito por instalação, não por `org_id` dentro do banco. Escolhemos isso porque os dois usos previstos, a empresa e a família, já rodam em instalações separadas, e multi-tenant custaria uma coluna, um escopo e um teste em toda tabela sem que ninguém precise dele.

## Consequências

- Nenhuma tabela tem `org_id`. Se um dia o Shearim servir vários grupos numa instalação, isso é um esforço novo, com migração de todas as tabelas.
- A conta de IA, os Agentes, os orçamentos e os papéis são da instalação inteira.
