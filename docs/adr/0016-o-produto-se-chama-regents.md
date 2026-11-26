# O produto se chama Regents

O produto deixa de se chamar Shearim e passa a se chamar Regents. No Brasil, o nome se fala "regentes"; em inglês, "regents". Cada língua fala do seu jeito, porque o teste que importa é outro: quem ouve o nome consegue escrever, e quem lê consegue falar. Shearim não passa nesse teste: a pronúncia é estranha, e um ditado por voz o transcreveu como "sharing". O nome vem de Regnt, a marca do Rafael, com "gnt", que é "gente": pessoas e Agentes trabalhando juntos. Escolhemos a grafia Regents, e não Regnts, porque "Regnts" não tem uma leitura natural e só faz sentido para quem conhece a abreviação. "gnt = gente" fica como a história do nome.

## Considered Options

- **Regnts**: a ideia original, mas ninguém sabe ler sem explicação, o mesmo problema de Shearim.
- **Regentes**: escreve como se fala e tem "gente" dentro, mas é português, e o nome devia ter cara de inglês.
- **Workmates**, **Coteam** e **Junto**: livres no npm e sem produto de IA para times com esse nome, mas sem a ligação com Regnt.
- **Guild**, **Unison**, **Quorum**, **Crewly** e **Roundtable**: já são nomes de produtos ou projetos de agentes de IA.
- **Plural**: já é o nome de outras empresas de software e está ocupado no npm.

## Consequências

- A troca vem logo depois da próxima PR e muda tudo: a tela, o README, o glossário, as variáveis `SHEARIM_*`, a imagem, o instalador e o repositório no GitHub.
- Uma Instalação nova nasce com o nome novo em tudo, inclusive o hostname, a tag da tailnet e o papel e o banco do Postgres.
- Uma Instalação que já existe (a da Extraevo) migra o nome na primeira atualização: o `.env` passa de `SHEARIM_*` para `REGENTS_*`, e os volumes são copiados para os do projeto novo. O hostname, a tag da tailnet e o papel e o banco do Postgres ficam os de antes. Trocar o hostname ou a tag muda a URL, e aí o app na Tela de Início, as inscrições de push e o GitHub App da Instalação param. O Postgres não renomeia o papel da própria sessão, e o nome do banco não aparece para ninguém. Quem cuida da Instalação pode trocar esses valores depois. Os detalhes estão na spec #96.
- O domínio não foi verificado.
