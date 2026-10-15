# Hub de influencers

`Hub de influencers.html` é a versão original, feita para rodar como Artifact no claude.ai.
A pasta `public/` + `src/worker.js` é a versão hospedada no **Cloudflare Workers**:

| Recurso do claude.ai | No Cloudflare |
|---|---|
| `db` (dados em tempo real) | D1 `hub-influencers` + atualização a cada 8 s (shim no início de `public/index.html`) |
| `user` (quem é admin) | Cloudflare Access (aba **Access** do Worker) + variável `ADMINS` |
| `assets` (mídia kits) | KV `hub-influencers-midiakits` (até 20 MB por arquivo) |
| `mcp` (Gmail) | Desativado: os botões de Gmail não aparecem |

O D1 (já com as tabelas de `schema.sql`) e o KV já foram criados na conta, e os IDs estão em `wrangler.jsonc`.

## Publicar (tudo pelo painel, sem instalar nada)

1. **Conectar o GitHub**: dash.cloudflare.com → *Workers & Pages* → *Create* → *Import a repository* → `cesantos-png/influencer`.
   - Nome do projeto: `hub-influencers` (igual ao `name` do `wrangler.jsonc`)
   - Branch de produção: `main` (ou a branch desta mudança, enquanto testa)
   - Build command: vazio · Deploy command: `npx wrangler deploy`
2. **Login (Cloudflare Access)**: abra o Worker `hub-influencers` → aba **Access** → **Protect this Worker behind Access** →
   escolha **All traffic** → em *Authentication policy* escolha **Email domain** e digite `ahi.com.br` → **Apply Access**.
3. **Administradores**: no Worker → *Settings* → *Variables and Secrets* → *Add* → tipo *Text*, nome `ADMINS`,
   valor com os e-mails de quem administra o hub separados por vírgula → *Deploy*.
4. Abra `https://hub-influencers.<sua-conta>.workers.dev` e entre com o código enviado ao e-mail.
5. (Opcional) **Domínio próprio**: *Settings* → *Domains & Routes* → *Add* → *Custom domain* (o DNS do domínio precisa estar no Cloudflare). A proteção da aba Access vale para todos os domínios do Worker.

Sem o passo 2, a API recusa todo acesso (a página mostra o aviso de "sem banco").

## Migrar os dados do Artifact

Abra `/importar.html` (só admins) e envie um JSON no formato
`{"docs":[{"path":"core/admin/influencers/inf-abc","data":{...}}]}`.
Mídia kits antigos precisam ser reenviados pelo próprio Hub.
