# Estrutura Modular Sugerida

Objetivo principal:
- UI sem regra de negocio
- Backend com responsabilidades separadas
- Facil trocar a UI depois sem quebrar o core

---

## Visao de Camadas

1. interfaces: telas/menus/controllers (entrada/saida)
2. application: casos de uso (orquestracao)
3. domain: regras puras (negocio)
4. infrastructure: integracoes externas (API, FS, processos)
5. composition: montagem de dependencias (DI/manual container)

---

## Arvore de Pastas

```text
src/
	composition/
		bootstrap.js
		container.js

	domain/
		entities/
			manga.entity.js
			chapter.entity.js
			link.entity.js
			app-config.entity.js
		value-objects/
			chapter-number.vo.js
			source-id.vo.js
			progress.vo.js
		policies/
			enqueue.policy.js
			cleanup.policy.js
			metadata.policy.js
		errors/
			domain.error.js

	application/
		use-cases/
			configure-app.usecase.js
			fetch-anilist-list.usecase.js
			manage-links.usecase.js
			enqueue-from-list.usecase.js
			cleanup-read-chapters.usecase.js
			organize-komga-library.usecase.js
			sync-komga-metadata.usecase.js
		services/
			chapter-planner.service.js
			metadata-builder.service.js
			title-matching.service.js
		dto/
			commands/
			queries/
			results/

	ports/
		repositories/
			config.repository.port.js
			list.repository.port.js
			downloads.repository.port.js
			links.repository.port.js
		gateways/
			anilist.gateway.port.js
			suwayomi.gateway.port.js
			komga.gateway.port.js
		presenters/
			ui.presenter.port.js

	infrastructure/
		repositories/
			fs-config.repository.js
			fs-list.repository.js
			fs-downloads.repository.js
			fs-links.repository.js
		gateways/
			anilist.graphql.gateway.js
			suwayomi.http.gateway.js
			komga.http.gateway.js
		process/
			jar-runner.js
		logging/
			logger.js

	interfaces/
		ui-cli/
			menus/
				main.menu.js
				settings.menu.js
				links.menu.js
				pipeline.menu.js
			presenters/
				cli.presenter.js
			mappers/
				ui-command.mapper.js
				ui-view.mapper.js
		api-http/
			routes/
			controllers/

	shared/
		constants/
		utils/
		types/
```

---

## Regra de Ouro da UI

UI apenas:
- coleta input
- chama caso de uso
- renderiza resultado

UI nunca faz:
- regra de negocio
- acesso direto a AniList/Komga/Suwayomi
- acesso direto aos JSONs de dados

---

## Fluxo Ideal (exemplo)

1. Usuario clica em Limpar capitulos lidos
2. UI cria comando e chama cleanup-read-chapters.usecase
3. Use case aplica cleanup.policy (manter capitulo atual)
4. Use case chama suwayomi.gateway para apagar anteriores
5. Presenter formata resultado
6. UI exibe resumo final

---

## Ordem Recomendada de Migracao

1. Extrair ports de repositorio (config, list, downloads, links)
2. Mover Configuracoes para configure-app.usecase
3. Mover Limpeza de capitulos para cleanup-read-chapters.usecase
4. Mover Organizar biblioteca e Sync Komga para use cases separados
5. Deixar menus apenas como camada de input/output
6. Eliminar chamadas diretas UI -> cli-logic legado

---

## Beneficios

- troca de UI sem refazer backend
- testes mais simples por caso de uso
- menos regressao ao alterar fluxo
- codigo mais reutilizavel e previsivel

---

# Manual prático de organização (para você aplicar sozinho)

Objetivo: dar passos claros, pequenos e verificáveis para migrar o projeto para uma estrutura modular, mantendo tudo testável e reversível.

Princípios rápidos (leia antes de mexer):
- Faça pequenas mudanças atômicas e testáveis.
- Extraia contratos (ports) antes de mover implementações.
- Mantenha o comportamento atual funcionando: primeiro escrever testes ou scripts de verificação rápida.
- Commit frequente; cada commit deve ser reversível e ter mensagem clara.

Como pensar (mental model):
- Domínio = regras do seu app (o que ele faz). Nunca dependa de HTTP/FS nessa camada.
- Use cases = orquestram domínio + ports. São unidades que você pode testar sem infra.
- Ports = contratos (funções/assinaturas) que adaptadores implementam.
- Adapters/infra = tradução entre o mundo externo e o seu contratointerno.

Checklist inicial (coisas fáceis, alto impacto):
1. Criar pastas/estruturas (feito).  
2. Escolher uma feature pequena para migrar (recomendo: `cleanup-read-chapters`).  
3. Identificar o código existente que implementa essa feature (buscar em `src/cli-logic.js` e `src/UI/menus`).  
4. Definir um `port` (contrato) para cada dependência externa usada (ex.: storage, suwayomi).  
5. Escrever um pequeno teste/verniz que valide o comportamento atual (pode ser script que roda a função e valida saída).  

Passo a passo prático (primeira migração — `cleanup-read-chapters`):
1) Entendimento
	- Abra `src/cli-logic.js` e copie a função que faz a limpeza de capítulos lidos. Leia e identifique entradas/saídas.
2) Contrato (port)
	- Crie `src/features/cleanup-chapters/ports/storage.port.js` com a assinatura mínima que precisa (ex.: `getDownloads(seriesId)`, `deleteChapter(filePath)`).
3) Adapter mínimo
	- Implemente um adapter que chame o código existente (thin wrapper) em `src/features/cleanup-chapters/infra/fs.adapter.js`. Assim você não muda comportamento de uma vez.
4) Use-case
	- Mova a orquestração para `src/features/cleanup-chapters/application/cleanupReadChapters.usecase.js`. Use o `port` em vez de chamadas diretas ao FS/Suwayomi.
5) Wire (composition)
	- Atualize `src/composition/bootstrap.js` (ou crie um) para injetar o adapter no use-case. Não remova o original — apenas adicione a nova rota/command que chama o use-case.
6) Verificação
	- Rode o mesmo fluxo via CLI apontando para a nova rota e compare resultados (logs, número de arquivos deletados). Se tudo ok, faça commit.
7) Refatoração
	- Afine o adapter (retry, timeout) e escreva testes unitários para o use-case (mockando o port).

Como organizar commits e PRs
- Commit 1: criar `port` com documento de assinatura (ex.: README pequeno).  
- Commit 2: adapter thin wrapper que usa o código atual.  
- Commit 3: criar use-case e trocar uma chamada da UI para chamá-lo (sem excluir código legado).  
- Commit 4: testes unitários e integração leve.  
- Commit 5: remover código legado quando tudo estiver coberto.

Convivendo com serviços externos (Komga / Suwayomi)
- Encapsule chamadas externas no adapter. Nunca espalhe URLs/auth por todo lugar.  
- Adapter deve oferecer: retries, timeouts, backoff e logging.  
- Adicione cache local com TTL para permitir modo degradado quando serviço estiver fora.  
- Escreva testes de contrato: um script simples que valida as chamadas principais contra o endpoint de homologação (ou um mock controlado).

Boas práticas de teste e verificação
- Unit tests para use-cases (mocks dos ports).  
- Contract/integration tests para adapters (pode ser manual no início).  
- Smoke test CLI: script que roda fluxo e checa artefatos esperados.  
- Adicione um `npm run smoke` que execute checks básicos.

Pequenas tarefas para praticar (cada uma 30–90 minutos)
1. Extrair port `downloads.repository.port` e um adapter thin para `fs` (criar e testar).  
2. Migrar a função de limpeza de capítulos para um use-case usando esse port.  
3. Escrever um unit test para o use-case (mock do port).  
4. Implementar retry simples no adapter do suwayomi para chamadas POST.  

Checklist de revisão antes de remover código legado
- Cobertura de testes para o use-case >= 80% nas partes migradas.  
- Smoke test manual reproduz o mesmo comportamento.  
- Logs demonstram que adapter recebeu as mesmas entradas.  
- Commit/PR com mudança pequena e revertível.

Resumo final — estratégia recomendada:
- Comece com Feature‑First para ganhar velocidade: migre `cleanup-read-chapters` como exemplo.  
- Para cada feature, extraia ports e adapters; escreva testes para o use-case.  
- Após 2–3 features estabilizadas, centralize os `ports` em `shared/ports` e mova para um estilo mais hexagonal (se desejar).  

Quer que eu gere arquivos esqueleto (ports, use-case e adapter) para `cleanup-read-chapters` agora como exemplo prático? 

