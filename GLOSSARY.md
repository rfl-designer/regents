# Regents

Chat de time em que pessoas e agentes de IA conversam nos mesmos lugares. Cada instalação serve um único Workspace.

## Language

### Quem participa

**Workspace**:
O grupo de pessoas, agentes e conversas servido por uma instalação do Regents. Uma instalação tem exatamente um Workspace.
_Avoid_: organização, tenant, espaço, time

**Instalação**:
Um Regents rodando num computador do time, com o próprio banco e os próprios segredos. Serve exatamente um Workspace. O Admin vê o estado dela: a versão, o último backup e quando ela sai da tailnet.
_Avoid_: instância, servidor, deploy

**Membro**:
Uma pessoa do Workspace, reconhecida pela identidade estável que a tailnet dá a ela. É o papel de quem conversa e cria canais. Só se torna Membro quem teve o Pedido de entrada aprovado, exceto o primeiro, que entra direto como Admin.
_Avoid_: usuário, colaborador

**Pedido de entrada**:
O pedido que uma pessoa cria ao chegar ao Workspace pela primeira vez. Fica com os Admins, que o aprovam ou recusam. Quem pediu sempre vê em que pé ele está.
_Avoid_: convite, cadastro, solicitação de acesso

**Admin**:
O papel de Membro que configura o Workspace: a Chave do Workspace, os Agentes, os orçamentos e quem entra. Não dá acesso de leitura a conversas das quais não participa. O primeiro Membro de uma instalação é Admin; um Admin pode tornar outro Membro Admin, e o Workspace sempre tem pelo menos um.
_Avoid_: dono, administrador do sistema

**Conta**:
A ligação de um Membro à assinatura do Claude dele, feita pela própria pessoa. Paga a IA gasta por causa das mensagens desse Membro e das Sincronizações que ele inicia, e de mais ninguém. Dois Membros podem ter Contas na mesma assinatura; o limite da assinatura vale para os dois. A ligação vale por algumas semanas; antes do fim, o Membro é avisado e a liga de novo.
_Avoid_: login, plano, assinatura do Workspace

**Chave do Workspace**:
A chave de API opcional do Workspace, configurada pelo Admin. Paga a IA de quem não tem Conta ou está com a Conta no limite.
_Avoid_: chave da plataforma, conta do Workspace

**Contexto do Workspace**:
Um texto curto e opcional, escrito pelo Admin, sobre quem é o Workspace e como ele fala. Entra no contexto de todo Agente, em todo Canal e DM.
_Avoid_: prompt global, perfil da empresa

**Agente**:
Um participante de IA do Workspace, com nome, descrição, instruções, modelo e orçamento mensal próprios. A descrição é pública e diz para que ele serve; as instruções dizem como ele age. Só o Admin edita um Agente.
_Avoid_: bot, assistente, IA

**Articuladora**:
O Agente que vem com o Workspace, se chama Sophya por padrão e está em todo Canal, público ou privado. Não pode ser apagada nem removida de um Canal. Num Canal com outros Agentes, ela dá o Desfecho de cada mensagem de pessoa; num Canal só com ela, responde só por Menção. Conhece todos os Agentes, com as Ferramentas de cada um e o nome e a descrição das Habilidades e das Wikis de cada um, e os Canais que quem escreveu pode ver. Só o Admin troca o nome, o modelo e o orçamento dela; as instruções dela são do Regents.
_Avoid_: Líder, braço direito, router, coordenador

### O que os Agentes sabem

**Wiki**:
Um conjunto nomeado de páginas em markdown, ligadas entre si e com um índice, que a Articuladora mantém a partir das Fontes. A Memória nasce das conversas; a Wiki nasce das Fontes que o Admin sobe. Tem um alcance próprio: pública (todo Membro) ou restrita a uma lista de Membros. O Admin liga cada Wiki a Canais, a Agentes ou aos dois: todo Agente de um Canal ligado a consulta ali, e um Agente ligado a ela a consulta em qualquer conversa, mas só numa conversa em que todos os participantes estão dentro do alcance. Ler a Wiki é uma Ferramenta de leitura que o Agente tem sempre que uma Wiki o alcança. Cada página diz de quais Fontes veio. Os Membros dentro do alcance navegam pela Wiki sem editar; só o Admin a mantém.
_Avoid_: Conhecimento, base de conhecimento, RAG, segundo cérebro, documentação

**Fonte**:
Um texto ou markdown bruto que o Admin sobe numa Wiki, como um curso transcrito. Não muda depois de subir: é a Wiki que muda a partir dela. Quando o Admin remove uma Fonte, a próxima Sincronização retira da Wiki o que vinha só dela.
_Avoid_: arquivo, upload, documento, material

**Sincronização**:
O trabalho da Articuladora que leva as Fontes de uma Wiki para as páginas dela: cria e liga páginas, atualiza o índice e aponta contradições e páginas sem link. Só o Admin a inicia, e o clique dele autoriza a Sincronização inteira, sem Pedido de aprovação. A Wiki só muda quando ela termina; se falhar ou for cancelada, a Wiki fica como estava. Cada Sincronização concluída gera uma versão da Wiki, e o Admin pode voltar à anterior. As regras da Sincronização são do Regents.
_Avoid_: ingestão, indexação, processamento, atualização

### Onde se conversa

**Canal**:
Uma sala nomeada do Workspace, com instruções, onde pessoas e Agentes conversam. As Instruções do Canal entram no contexto de todo Agente que fala ali. É público (qualquer Membro vê e entra) ou privado (só quem participa vê).
_Avoid_: sala, grupo, chat

**DM**:
Uma conversa privada sem nome, fora dos Canais: entre uma pessoa e um Agente, entre duas pessoas, ou em grupo. Não tem Desfecho: um Agente só fala na DM com ele ou quando é mencionado.
_Avoid_: mensagem direta, privado, conversa

**Thread**:
Uma sequência de respostas pendurada numa mensagem, fora do fluxo principal da conversa. Cada mensagem de pessoa nela também recebe Desfecho da Articuladora, que prefere os Agentes que já falaram ali.
_Avoid_: fio, tópico, subconversa

**Thread seguida**:
Uma Thread que um Membro acompanha e da qual é avisado: a do autor da mensagem-raiz, de quem respondeu nela e de quem foi mencionado nela. Agentes não seguem Threads.
_Avoid_: inscrição, assinatura, watch

### Como os Agentes agem

**Menção**:
A citação explícita de um participante numa mensagem (`@nome`), pessoa ou Agente. Quem é mencionado é avisado. Um Agente mencionado responde direto, sem passar pela Articuladora, mas só quando a Menção foi escrita por uma pessoa.
_Avoid_: marcação, tag, chamada

**Desfecho**:
O resultado visível que a Articuladora dá a uma mensagem de pessoa num Canal com outros Agentes: responder, delegar a até dois Agentes do Canal, ou marcar que nenhum Agente precisa agir, sempre com um motivo de uma frase. Uma mensagem num Canal assim nunca fica sem Desfecho.
_Avoid_: roteamento, decisão, triagem

**Ferramenta**:
Uma ação que um Agente pode usar durante uma resposta: ler o Workspace, ler a web, ou ler e agir num sistema de fora por um Conector. O Admin escolhe as Ferramentas de cada Agente, inclusive as da Articuladora. No Workspace, uma Ferramenta alcança só o que o autor da mensagem e todos os participantes da conversa podem ver. Toda escrita passa por um Pedido de aprovação; leitura não. Um Agente só escreve em conversas que a resposta alcança, de que ele participa e em que o autor pode escrever. O uso de uma Ferramenta aparece no Andamento, e o que ela gasta conta no orçamento do Agente. Uma resposta usa Ferramentas até um teto; ao chegar nele, o Agente responde com o que tem. O Desfecho nunca usa Ferramentas.
_Avoid_: tool, skill, capacidade, função

**Habilidade**:
Um procedimento escrito por gente, com nome e descrição, que um Agente carrega só quando a tarefa pede. A Memória do Agente é aprendida nas conversas; a Habilidade é escrita. O Admin instala a Habilidade no Workspace e escolhe em quais Agentes ela fica ativa. Deixa as instruções do Agente curtas: elas dizem quem ele é, e as Habilidades dizem como fazer cada tarefa. Diz *como fazer*, enquanto a Wiki diz *o que se sabe*.
_Avoid_: skill, prompt, macro, receita

**Conector**:
A ligação do Workspace a um sistema de fora, adicionada pelo Admin, que traz as Ferramentas desse sistema. A credencial é de cada Membro, que liga a sua, ou do Workspace, uma só para todos. Com a credencial do Workspace, quem fala com o Agente alcança o que ela alcança, e a descrição do Agente diz isso. Um Conector alcança o que a credencial alcança, mesmo numa conversa com quem não teria esse acesso, e o Andamento mostra de quem é a credencial usada. Para um autor que não ligou a credencial dele, as Ferramentas do Conector ficam indisponíveis naquela resposta, e só ele vê como ligá-la. O GitHub é um Conector que vem com o Regents: o Admin o instala na conta do time no GitHub, escolhe os repositórios e pode restringir cada Agente a alguns deles.
_Avoid_: integração, plugin, app, MCP

**Pedido de aprovação**:
O pedido que uma resposta de Agente cria antes de toda escrita, mostrando exatamente o que vai ser feito. Todos da conversa o veem, e só o autor da mensagem que disparou a resposta o aprova ou recusa, sem editar o que vai ser feito. Depois de aprovado, ou recusado com um motivo opcional, o Agente continua a resposta. Expira em 24 horas, e aí a resposta termina sem continuar.
_Avoid_: approval, confirmação, permissão

**Andamento**:
O estado visível do tratamento de uma mensagem pelos Agentes, do recebimento até a resposta, a falha com motivo ou o cancelamento por quem escreveu. Uma mensagem que envolve Agentes sempre termina em resposta, em falha visível ou em cancelamento visível, nunca no limbo.
_Avoid_: status, progresso, execução

### O que os Agentes lembram

**Memória**:
O que fica de uma conversa para os Agentes usarem em respostas futuras, sempre com a conversa de origem. Só entra numa resposta que alcança essa origem: o que nasceu num Canal privado ou numa DM não aparece fora do alcance dela, nem pelo nome. É guardada pelo Regents ao fim de uma resposta de Agente, a partir do que as pessoas disseram naquela troca, à vista no Andamento e sem Pedido de aprovação; uma conversa só entre pessoas não vira Memória, nem o que veio de fora por uma Ferramenta. Quem vê a conversa de origem pode desfazer ou corrigir o que foi guardado, e cada Membro, Admin inclusive, só vê a Memória cuja origem ele vê. Uma correção substitui a versão anterior, que fica arquivada. O Admin liga ou desliga a Memória de cada Agente, e o Desfecho não a lê. Não substitui o Contexto do Workspace, as Instruções do Canal nem as instruções do Agente, que são escritos por gente e valem acima dela quando se contradizem.
_Avoid_: lembrança, conhecimento, contexto, histórico

**Memória do Workspace**:
A Memória que vale em todo o Workspace. Quem a escreve é um Admin, direto ou promovendo um item da Memória da Conversa de um Canal público; o Regents não guarda nela sozinho.
_Avoid_: memória global, memória do time

**Memória da Conversa**:
A Memória dos fatos e das decisões de um Canal ou de uma DM, com as Threads deles, igual para todos os Agentes que falam ali.
_Avoid_: memória do canal, memória da DM, resumo do canal

**Memória do Agente**:
A Memória do jeito de trabalhar de um Agente: as lições e as correções que as pessoas deram a ele. Fatos sobre o mundo não ficam aqui, ficam na Memória da Conversa de origem. Sai junto com o Agente quando ele é apagado.
_Avoid_: playbook, aprendizados, personalidade

**Tarefa**:
Um trabalho designado a um Agente que vai além de uma resposta e tem estado próprio. Ainda não foi modelada.
_Avoid_: missão, job, ticket, issue
