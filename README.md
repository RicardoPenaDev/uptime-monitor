# 📡 Uptime Monitor

Monitor de disponibilidade **self-hosted** para serviços HTTP/HTTPS e TCP, com
interface web, notificações por **WhatsApp** (via [Evolution API](https://github.com/EvolutionAPI/evolution-api))
e **Telegram**, histórico de latência e autenticação de administrador.

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![docker](https://img.shields.io/badge/docker-ready-2496ED)

---

## ✨ Funcionalidades

- ✅ Monitoramento **HTTP/HTTPS** com validação de status code
- ✅ Monitoramento **TCP/porta** (ideal para DB, SSH, APIs internas)
- ✅ Alertas de **queda** e **recuperação** via WhatsApp e/ou Telegram
- ✅ Suporte a múltiplos destinatários em ambos os canais
- ✅ Dashboard com uptime em 24h e 7 dias, latência média e histórico
- ✅ Intervalo de verificação configurável por monitor (30s a 10min)
- ✅ Histórico de 500 verificações por monitor, com barras visuais
- ✅ Verificação manual sob demanda
- ✅ **Autenticação de admin** com setup no primeiro acesso (bcrypt + sessão em cookie)
- ✅ Persistência em JSON — sem banco de dados externo
- ✅ Pronto pra Docker / Docker Compose

---

## 🚀 Rodando em 1 minuto (Docker Compose)

```bash
# 1. Clone o repositório
git clone https://github.com/RicardoPenaDev/uptime-monitor.git
cd uptime-monitor

# 2. Copie o compose de exemplo
cp docker-compose.example.yml docker-compose.yml

# 3. Build e sobe
docker compose up -d --build
```

Abra **http://localhost:3000** — o wizard pede pra criar a conta de admin na
primeira visita.

### Rodando via Node (sem Docker)

Requer **Node.js 18+**:

```bash
git clone https://github.com/RicardoPenaDev/uptime-monitor.git
cd uptime-monitor
npm install
npm start
```

---

## 🔐 Autenticação

O painel é protegido por uma conta única de **administrador**.

### Primeiro acesso
Ao abrir a URL pela primeira vez, um wizard pede para criar usuário e senha
(mínimo 8 caracteres). Depois disso, todo acesso passa pela tela de login.

### Trocar a senha
Logado, use o botão **"Alterar senha"** no canto inferior da barra lateral.
É exigida a senha atual para confirmar a alteração.

### Esqueci a senha (reset)
Não há recuperação por e-mail. Para redefinir, apague o arquivo de credenciais
e reinicie o container — na próxima visita o wizard inicial reaparece.

```bash
# Docker Compose
docker compose exec uptime-monitor rm /app/data/auth.json
docker compose restart uptime-monitor
```

> ⚠️ Isso também invalida todas as sessões ativas, pois o `sessionSecret`
> é regerado no próximo setup.

---

## 🔔 Configuração das notificações

Acesse **Configurações** no painel web e preencha conforme o canal desejado.

### WhatsApp via Evolution API
- **URL da API** — ex.: `https://sua-evolution-api.com`
- **Instância** — nome da instância conectada ao WhatsApp
- **API Key** — chave de autenticação
- **Números** — lista com DDI+DDD+número (só dígitos, ex.: `5511999999999`)
- Clique em **Testar Notificação** para validar

### Telegram
- **Bot Token** — crie um bot com o [@BotFather](https://t.me/botfather)
- **Chat IDs** — IDs dos destinatários (use o [@userinfobot](https://t.me/userinfobot) para descobrir)
- Envie uma mensagem para o bot antes de testar (permissão de escrita)

Você pode usar **os dois canais ao mesmo tempo**.

---

## 📋 Tipos de monitor

### HTTP / HTTPS
- Monitora uma URL completa
- Verifica status HTTP — `< 500` é considerado online por padrão
- Opcional: definir um status esperado específico (ex.: `200`, `301`)

### TCP / Porta
- Testa conexão em `host:porta`
- Exemplos: `db.interno:3306` (MySQL), `10.0.0.1:22` (SSH)

---

## 📨 Formato das notificações

**Serviço caiu:**
```
🔴 [UPTIME MONITOR] CAIU

Monitor: Meu Site
Alvo: https://meusite.com
Horário: 14/01/2026 15:32:00
```

**Serviço voltou:**
```
✅ [UPTIME MONITOR] VOLTOU

Monitor: Meu Site
Alvo: https://meusite.com
Latência: 145ms
Horário: 14/01/2026 15:35:00
```

---

## 🌐 API REST

Todas as rotas `/api/*` (exceto `/api/auth/*`) exigem sessão ativa.
Sem sessão, retornam **401**.

### Autenticação

| Método | Rota                        | Descrição |
|--------|-----------------------------|-----------|
| GET    | `/api/auth/status`          | Estado do setup e da sessão |
| POST   | `/api/auth/setup`           | Cria a conta admin (apenas no primeiro acesso) |
| POST   | `/api/auth/login`           | Inicia sessão |
| POST   | `/api/auth/logout`          | Encerra sessão |
| POST   | `/api/auth/change-password` | Troca a senha (requer sessão) |

### Monitores e configuração

| Método | Rota                            | Descrição |
|--------|---------------------------------|-----------|
| GET    | `/api/monitors`                 | Listar monitores |
| POST   | `/api/monitors`                 | Criar monitor |
| PUT    | `/api/monitors/:id`             | Editar monitor |
| DELETE | `/api/monitors/:id`             | Remover monitor |
| POST   | `/api/monitors/:id/check`       | Forçar verificação |
| GET    | `/api/monitors/:id/history`     | Histórico |
| GET    | `/api/config`                   | Ler configuração |
| POST   | `/api/config`                   | Salvar configuração |
| POST   | `/api/test-whatsapp`            | Testar notificação WhatsApp |
| POST   | `/api/test-telegram`            | Testar notificação Telegram |
| GET    | `/api/stats`                    | Estatísticas gerais |

---

## 📁 Estrutura de arquivos

```
uptime-monitor/
├── server.js                  # Servidor HTTP + schedulers de monitor
├── auth.js                    # Helpers de autenticação (bcrypt, load/save)
├── routes-auth.js             # Rotas /api/auth/*
├── package.json
├── Dockerfile
├── docker-compose.example.yml # Template (copie para docker-compose.yml)
├── public/
│   └── index.html             # Interface web (SPA única)
└── data/                      # Criado automaticamente (git-ignored)
    ├── monitors.json          # Monitores cadastrados
    ├── config.json            # Config de notificações
    ├── history.json           # Histórico de verificações
    └── auth.json              # Credenciais (senha em bcrypt)
```

---

## 🔧 Variáveis de ambiente

| Variável    | Default       | Descrição |
|-------------|---------------|-----------|
| `PORT`      | `3000`        | Porta HTTP do servidor |
| `NODE_ENV`  | `production`  | `production` habilita `cookie.secure` (requer HTTPS) |
| `TZ`        | (do sistema)  | Timezone do container (ex.: `America/Sao_Paulo`) |

---

## 🔒 Rodando atrás de reverse proxy (Traefik, Nginx, Caddy)

O app chama `app.set('trust proxy', 1)`, então o cookie `secure` funciona
corretamente atrás de reverse proxy com TLS.

Um exemplo com Traefik está comentado em `docker-compose.example.yml`.

---

## 🗂️ Backup / restore dos dados

Tudo o que importa (monitores, histórico, config e credenciais) está em
`data/`. Com Docker, em volume nomeado:

```bash
# Backup
docker run --rm -v uptime_uptime_data:/src -v "$PWD":/dst alpine \
  tar czf /dst/uptime-backup.tar.gz -C /src .

# Restore
docker run --rm -v uptime_uptime_data:/dst -v "$PWD":/src alpine \
  sh -c "cd /dst && tar xzf /src/uptime-backup.tar.gz"
```

---

## 🤝 Contribuindo

PRs são bem-vindos. Antes de abrir, rode `docker compose build` pra garantir
que o container ainda sobe, e teste o fluxo manual de auth (setup → login →
criar monitor → logout).

---

## 📜 Licença

MIT — veja [LICENSE](LICENSE).
