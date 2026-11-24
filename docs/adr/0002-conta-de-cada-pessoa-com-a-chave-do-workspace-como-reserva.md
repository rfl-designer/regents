# Conta de cada pessoa, com a Chave do Workspace como reserva

Emendado pelo ADR 0005: a Conta é o login do próprio Claude Code numa pasta por Membro, e não um token guardado no banco.

A IA gasta por causa de uma mensagem (o roteamento da Articuladora, a resposta e os Agentes delegados) sai da Conta de quem escreveu a mensagem: a assinatura do Claude que essa pessoa ligou, rodando o Claude Code headless com as tools desligadas. Quem não tem Conta, ou está com ela no limite, usa a Chave do Workspace, uma chave de API opcional chamada pela Messages API. Escolhemos isso para que cada assinatura só atenda o próprio dono, o uso mais defensável nos termos da Anthropic, sem deixar de fora quem não tem assinatura.

## Considered Options

- Uma assinatura só, pensando por todos os Agentes e todas as pessoas: mais simples, mas uma assinatura pessoal atendendo outras pessoas pode violar os termos e levar à suspensão da conta.
- Só a Chave do Workspace: um cérebro só e claramente dentro dos termos, mas cobrado por token mesmo para quem já paga uma assinatura.

## Consequências

- Há dois cérebros, o Claude Code (Conta) e a Messages API (Chave do Workspace), atrás da mesma porta de chamada de modelo.
- Conta no limite passa para a Chave do Workspace de forma visível no Andamento, com a hora em que a Conta volta (ADR 0003). Sem Conta e sem Chave, os Agentes não agem, e o Desfecho diz o porquê.
- O estado da Conta de alguém é só dele: todos veem que uma resposta saiu pela Chave do Workspace, mas só o autor da mensagem vê que a Conta dele está no limite ou não existe, e a hora em que volta.
- O orçamento mensal de um Agente conta só o gasto na Chave do Workspace. Estourado, o Agente deixa de usar a Chave e continua respondendo a quem tem Conta.
- ~~O token de cada Conta fica criptografado no banco, nunca volta ao navegador e só é decifrado para iniciar a execução do dono.~~ Substituído pelo ADR 0005: o Shearim não guarda token; o login fica com o Claude Code, na pasta do Membro. Nem o Admin tem acesso a ele.
