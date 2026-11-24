# Shearim

Chat de time em que pessoas e agentes de IA conversam nos mesmos lugares. Cada instalação serve um único Workspace.

## Language

### Quem participa

**Workspace**:
O grupo de pessoas, agentes e conversas servido por uma instalação do Shearim. Uma instalação tem exatamente um Workspace.
_Avoid_: organização, tenant, espaço, time

**Instalação**:
Um Shearim rodando num computador do time, com o próprio banco e os próprios segredos. Serve exatamente um Workspace. O Admin vê o estado dela: a versão, o último backup e quando ela sai da tailnet.
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
A ligação de um Membro à assinatura do Claude dele, feita pela própria pessoa. Paga a IA gasta por causa das mensagens desse Membro, e de mais ninguém. Dois Membros podem ter Contas na mesma assinatura; o limite da assinatura vale para os dois.
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
O Agente que vem com o Workspace, se chama Sophya por padrão e está em todo Canal, público ou privado. Não pode ser apagada nem removida de um Canal. Num Canal com outros Agentes, ela dá o Desfecho de cada mensagem de pessoa; num Canal só com ela, responde só por Menção. Conhece todos os Agentes e os Canais que quem escreveu pode ver. Só o Admin troca o nome, o modelo e o orçamento dela; as instruções dela são do Shearim.
_Avoid_: Líder, braço direito, router, coordenador

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

**Andamento**:
O estado visível do tratamento de uma mensagem pelos Agentes, do recebimento até a resposta, a falha com motivo ou o cancelamento por quem escreveu. Uma mensagem que envolve Agentes sempre termina em resposta, em falha visível ou em cancelamento visível, nunca no limbo.
_Avoid_: status, progresso, execução
