# Hub de influencers

`Hub de influencers.html` é a versão original, feita para rodar como Artifact no claude.ai.
A pasta `public/` + `src/worker.js` é a versão hospedada no **Cloudflare Workers**:

| Recurso do claude.ai | No Cloudflare |
|---|---|
| `db` (dados em tempo real) | D1 `hub-influencers` + atualização a cada 8 s (`public/claude-shim.js`) |
| `user` (quem é admin) | Cloudflare Access + variável `ADMINS` |
| `assets` (mídia kits) | KV `hub-influencers-midiakits` (até 20 MB por arquivo) |
| `mcp` (Gmail) | Desativado: os botões de Gmail não aparecem |

O D1 (já com as tabelas de `schema.sql`) e o KV já foram criados na conta, e os IDs estão em `wrangler.jsonc`.

## Publicar (tudo pelo painel, sem instalar nada)

1. **Conectar o GitHub**: dash.cloudflare.com → *Workers & Pages* → *Create* → *Import a repository* → `cesantos-png/influencer`.
   - Nome do projeto: `hub-influencers` (igual ao `name` do `wrangler.jsonc`)
   - Branch de produção: `main` (ou a branch desta mudança, enquanto testa)
   - Build command: vazio · Deploy command: `npx wrangler deploy`
2. **Login com Cloudflare Access**: no Worker → *Settings* → *Domains & Routes* → no `workers.dev`, ative **Cloudflare Access**.
   O painel mostra o **team domain** (ex.: `ahi.cloudflareaccess.com`) e o **AUD**.
   Depois, em *Zero Trust* → *Access* → *Applications* → essa aplicação → *Policies*, deixe a regra *Allow* com
   "Emails ending in" `@ahi.com.br` (ou a lista de e-mails dos NARs).
3. **Variáveis**: no Worker → *Settings* → *Variables and Secrets*, crie (tipo texto):
   - `ACCESS_TEAM_DOMAIN` = `ahi.cloudflareaccess.com` (o seu)
   - `ACCESS_AUD` = o AUD do passo 2
   - `ADMINS` = e-mails de quem administra o hub, separados por vírgula
4. Abra `https://hub-influencers.<sua-conta>.workers.dev` e entre com o código enviado ao e-mail.
5. (Opcional) **Domínio próprio**: *Settings* → *Domains & Routes* → *Add* → *Custom domain* (o DNS do domínio precisa estar no Cloudflare). Proteja-o com Access do mesmo jeito.

Sem as variáveis do passo 3, a API recusa todo acesso (a página mostra o aviso de "sem banco").

## Migrar os dados do Artifact

Abra `/importar.html` (só admins) e envie um JSON no formato
`{"docs":[{"path":"core/admin/influencers/inf-abc","data":{...}}]}`.
Mídia kits antigos precisam ser reenviados pelo próprio Hub.
