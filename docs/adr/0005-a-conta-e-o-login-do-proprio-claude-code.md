# A Conta é o login do próprio Claude Code, numa pasta por Membro

Emenda o ADR 0002 no ponto em que o token de cada Conta ficava criptografado no banco.

A Conta de um Membro é um login feito pelo binário original do Claude Code (`claude auth login`) numa pasta só dele (`CLAUDE_CONFIG_DIR`), num volume do container. Quem grava e renova esse login é o próprio Claude Code. O Shearim não lê, não copia e não guarda o token em lugar nenhum. A pessoa liga a Conta sem terminal. Na tela do Shearim, ela abre a página de login da Anthropic, entra com a própria conta do Claude e cola de volta o código que essa página mostra. O Shearim só entrega esse código ao processo do Claude Code que está esperando por ele.

Escolhemos isso porque a página legal do Claude Code (code.claude.com/docs/en/legal-and-compliance, seção "Authentication and credential use", lida em 2026-11-23) proíbe o desenho anterior. O texto diz que a Anthropic "does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users" e que os desenvolvedores "may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow". Ressalva, porém, que isso não impede "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code". Este desenho se apoia nessa ressalva, como faz o agentes.chat (ADRs 0041 e 0059 dele). É uma leitura do texto, não uma permissão. A Anthropic avisa que pode bloquear "without prior notice". Se isso acontecer, a Chave do Workspace continua atendendo todo mundo.

## Considered Options

- **Token de `claude setup-token` criptografado no banco** (o ADR 0002 original): é "collect, store" de credencial, o que a regra veda. Esse token também não lê o uso do plano.
- **Só a Chave do Workspace**: é a opção sem risco. Foi recusada porque o time quer aproveitar as assinaturas que já paga.
- **API key pessoal gerada no Console**: é permitida, mas exige de quem não é técnico criar uma organização no Console, e não aproveita a assinatura Pro.

## Consequências

- O Claude Code renova sozinho o acesso de curta duração, mas o login tem uma data final, a cerca de semanas, que renovar e usar não adiam. Ela vem em `credential_expires_at` no `result` e na linha `Sign-in ends` de `claude auth status --text` (code.claude.com/docs/en/authentication, lida em 2026-11-23). Não existe o vencimento de um ano do `setup-token`. Quando o login cai (venceu, foi revogado, a senha mudou, a renovação foi recusada), a Conta fica em "Precisa ligar de novo". A execução segue pela Chave do Workspace, de forma visível, e o dono recebe um único push.
- O código colado passa pelo servidor do Shearim. Como não existe runner separado, não há ninguém de quem escondê-lo. É o ponto mais fraco da leitura acima.
- Desligar a Conta roda `claude auth logout` e apaga a pasta. A tela avisa que a ligação também pode ser removida em claude.ai/settings/claude-code.
- As pastas das Contas ficam num volume fora do backup do Postgres. Depois de uma restauração, cada Membro liga a Conta de novo.
- Uma Conta continua pagando só pelas mensagens do próprio dono. Duas pessoas podem ligar a mesma assinatura do Claude: o Shearim avisa que a assinatura é pessoal e avisa também o primeiro dono, mas não impede. O limite do plano vale para as duas; o login é de cada uma.
