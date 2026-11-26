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
- A instalação que já roda (a da Extraevo) precisa de uma versão que migre o `.env` e os volumes do nome antigo para o novo, para não quebrar na atualização.
- O domínio não foi verificado.
