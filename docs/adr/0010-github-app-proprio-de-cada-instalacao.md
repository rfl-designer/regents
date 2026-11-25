# Um GitHub App próprio de cada Instalação, num Conector embutido

O Conector do GitHub é a exceção à regra de que Conector é um servidor MCP remoto. Cada Instalação cria o próprio GitHub App pelo fluxo de manifest do GitHub, e a chave privada do App fica no banco da Instalação, cifrada como os outros segredos. O Admin instala o App na conta do time no GitHub e escolhe os repositórios lá. As Ferramentas do GitHub são do Shearim e chamam a API com um token de instalação curto, limitado ao repositório e às permissões da Ferramenta. A credencial é do Workspace: as escritas aparecem como o bot do App. Escolhemos isso porque o Shearim é self-hosted. Um App único do projeto obrigaria a distribuir a mesma chave privada a todas as Instalações, e um token colado pelo Admin dá acesso amplo demais e não expira.

## Considered Options

- **Um GitHub App público do projeto**, como no `agentes-chat`: a instalação é de um clique, mas a chave privada teria que sair de um lugar central para cada Instalação, ou o Shearim precisaria de um serviço próprio na internet emitindo tokens.
- **Token do GitHub colado num Conector MCP qualquer**: não exige código do Shearim, mas o token é de uma pessoa, alcança tudo o que ela alcança e só expira se alguém lembrar.

## Consequências

- Criar o App exige que o Admin abra a página do GitHub no navegador. O retorno do manifest e da instalação vai para o endereço da Instalação na tailnet, e quem faz o redirecionamento é o navegador do Admin, não o GitHub.
- O Shearim mantém o catálogo das Ferramentas do GitHub e o mapa de permissões de cada uma.
- A lista de repositórios por Agente é opcional. Sem ela, o Agente alcança tudo o que a instalação alcança.
