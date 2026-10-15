# Hub de influencers

`Hub de influencers.html` é a versão original, feita para rodar como Artifact no claude.ai.
A pasta `public/` + `src/worker.js` é a versão hospedada no **Cloudflare Workers**:

| Recurso do claude.ai | No Cloudflare |
|---|---|
| `db` (dados em tempo real) | D1 `hub-influencers` + atualização a cada 8 s (shim no início de `public/index.html`) |
| `user` (quem é admin) | "Entrar com Google" (só contas @ahi.com.br) + variável `ADMINS` |
| `assets` (mídia kits) | KV `hub-influencers-midiakits` (até 20 MB por arquivo) |
| `mcp` (Gmail) | Desativado: os botões de Gmail não aparecem |

O D1 (já com as tabelas de `schema.sql`) e o KV já foram criados na conta, e os IDs estão em `wrangler.jsonc`.

## Publicar (tudo pelo navegador, sem instalar nada e sem cartão)

1. **Conectar o GitHub**: dash.cloudflare.com → *Workers & Pages* → *Create* → *Import a repository* → `cesantos-png/influencer`.
   - Nome do projeto: `hub-influencers` (igual ao `name` do `wrangler.jsonc`)
   - Branch de produção: `main` (ou a branch desta mudança, enquanto testa)
   - Build command: vazio · Deploy command: `npx wrangler deploy`
   - Ao terminar, anote o endereço do Hub, do tipo `https://hub-influencers.<sua-conta>.workers.dev`.
2. **Criar o ID de login do Google** (gratuito, sem cartão), em console.cloud.google.com, logado com a conta @ahi.com.br:
   1. No seletor de projetos (topo), *Novo projeto* → nome `Hub de influencers` → *Criar* e selecione o projeto.
   2. Menu ☰ → *Google Auth Platform* (ou *APIs e serviços* → *Tela de consentimento OAuth*) → *Começar*:
      nome do app `Hub de influencers`, seu e-mail de suporte → público **Interno** → e-mail de contato → *Criar*.
   3. *Clientes* → *Criar cliente* → tipo **Aplicativo da Web** → em *Origens JavaScript autorizadas* adicione
      o endereço do passo 1 (sem barra no final) → *Criar*.
   4. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`). A "chave secreta" não é usada.
3. **Variáveis**: no Worker → *Settings* → *Variables and Secrets* → *Add* (tipo *Text*) → *Deploy*:
   - `GOOGLE_CLIENT_ID` = o ID do passo 2
   - `ADMINS` = e-mails de quem administra o hub, separados por vírgula
   - `ALLOWED_DOMAINS` (opcional) = domínios aceitos no login; o padrão é `ahi.com.br`
4. Abra o endereço do Hub e clique em *Sign in with Google*. A sessão dura 30 dias; o botão *Sair* fica no canto inferior direito.
5. (Opcional) **Domínio próprio**: *Settings* → *Domains & Routes* → *Add* → *Custom domain* (o DNS do domínio precisa estar no Cloudflare)
   e adicione esse endereço também nas *Origens JavaScript autorizadas* do Google.

Se "Interno" não aparecer no passo 2.2, o e-mail da empresa não está no Google Workspace: escolha *Externo* e publique o app
(*Público* → *Publicar app*). O Worker continua aceitando só e-mails dos domínios de `ALLOWED_DOMAINS`.

## Migrar os dados do Artifact

Abra `/importar.html` (só admins) e envie um JSON no formato
`{"docs":[{"path":"core/admin/influencers/inf-abc","data":{...}}]}`.
Mídia kits antigos precisam ser reenviados pelo próprio Hub.
