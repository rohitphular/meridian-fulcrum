.DEFAULT_GOAL := help
MAKEFLAGS    += --no-print-directory

# ── Help (self-documenting) ───────────────────────────────────────────────────

.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0,5) }' $(MAKEFILE_LIST)

##@ Infrastructure

.PHONY: infra-up
infra-up: ## Start PostgreSQL for an environment (interactive: pick env)
	@echo ""; \
	echo "  1) dev"; \
	echo "  2) prod"; \
	echo ""; \
	printf "Select environment: "; read -r CHOICE; \
	if [ "$$CHOICE" = "1" ]; then ENV="dev"; \
	elif [ "$$CHOICE" = "2" ]; then ENV="prod"; \
	else echo "Invalid choice '$$CHOICE'. Enter 1 or 2."; exit 1; \
	fi; \
	bash infrastructure/start-services.sh "$$ENV"

.PHONY: infra-down
infra-down: ## Stop PostgreSQL for an environment (interactive: pick env)
	@echo ""; \
	echo "  1) dev"; \
	echo "  2) prod"; \
	echo ""; \
	printf "Select environment: "; read -r CHOICE; \
	if [ "$$CHOICE" = "1" ]; then ENV="dev"; \
	elif [ "$$CHOICE" = "2" ]; then ENV="prod"; \
	else echo "Invalid choice '$$CHOICE'. Enter 1 or 2."; exit 1; \
	fi; \
	bash infrastructure/stop-services.sh "$$ENV"

##@ App

.PHONY: app-start
app-start: ## Start local HTTP server → http://localhost:8000/expense-tracker/app/
	@if [ -f .server.pid ] && kill -0 $$(cat .server.pid) 2>/dev/null; then \
		echo "Server already running (PID $$(cat .server.pid)) → http://localhost:8000/expense-tracker/app/"; \
	elif lsof -ti :8000 > /dev/null 2>&1; then \
		OTHER_PID=$$(lsof -ti :8000 | head -1); \
		echo "Port 8000 is in use by PID $$OTHER_PID."; \
		echo "  1) Kill it and start the server"; \
		echo "  2) Exit — I'll handle it myself"; \
		printf "#? "; read -r CHOICE; \
		if [ "$$CHOICE" = "1" ]; then \
			kill $$OTHER_PID && rm -f .server.pid; \
			python3 -m http.server 8000 --bind 127.0.0.1 --directory . > /dev/null 2>&1 & echo $$! > .server.pid; \
			echo "Server started (PID $$(cat .server.pid)) → http://localhost:8000/expense-tracker/app/"; \
		else \
			echo "Run: kill $$OTHER_PID — then re-run make app-start."; \
			exit 1; \
		fi; \
	else \
		python3 -m http.server 8000 --bind 127.0.0.1 --directory . > /dev/null 2>&1 & echo $$! > .server.pid; \
		echo "Server started (PID $$(cat .server.pid)) → http://localhost:8000/expense-tracker/app/"; \
	fi

.PHONY: app-stop
app-stop: ## Stop the local HTTP server
	@if [ -f .server.pid ] && kill -0 $$(cat .server.pid) 2>/dev/null; then \
		kill $$(cat .server.pid) && rm -f .server.pid; \
		echo "Server stopped."; \
	else \
		rm -f .server.pid; \
		echo "Server is not running."; \
	fi

.PHONY: api-deploy
api-deploy: ## Deploy GAS backend (interactive: pick env)
	bash expense-tracker/cicd/deploy.sh

.PHONY: api-logs
api-logs: ## Open GAS executions page in browser (interactive: pick env)
	bash expense-tracker/cicd/logs.sh

##@ Data Synchronization

.PHONY: data-sync
data-sync: ## Run one data-synchronization module interactively (pick module + env; the module asks for its own mode)
	@echo ""; \
	i=1; \
	for dir in data-synchronization/*/; do \
		[ -f "$${dir}cicd/start-up.sh" ] && [ "$$(basename $$dir)" != consolidated-pipeline ] && printf "  %d) %s\n" "$$i" "$$(basename $$dir)" && i=$$((i+1)); \
	done; \
	echo ""; \
	printf "Select module: "; read -r CHOICE; \
	i=1; \
	selected=""; \
	for dir in data-synchronization/*/; do \
		if [ -f "$${dir}cicd/start-up.sh" ] && [ "$$(basename $$dir)" != consolidated-pipeline ]; then \
			[ "$$i" = "$$CHOICE" ] && selected="$$dir" && break; \
			i=$$((i+1)); \
		fi; \
	done; \
	if [ -z "$$selected" ]; then \
		echo "Invalid choice '$$CHOICE'."; exit 1; \
	fi; \
	echo ""; \
	echo "  1) dev"; \
	echo "  2) prod"; \
	echo ""; \
	printf "Select environment: "; read -r ENV_CHOICE; \
	if [ "$$ENV_CHOICE" = "1" ]; then ENV="dev"; \
	elif [ "$$ENV_CHOICE" = "2" ]; then ENV="prod"; \
	else echo "Invalid choice '$$ENV_CHOICE'. Enter 1 or 2."; exit 1; \
	fi; \
	bash "$${selected}cicd/start-up.sh" --interactive "$$ENV"

.PHONY: consolidated-pipeline
consolidated-pipeline: ## Run the data-synchronization pipeline from data-synchronization/consolidated-pipeline/pipeline.json (CONFIG=path optional)
	bash data-synchronization/consolidated-pipeline/cicd/start-up.sh $(if $(CONFIG),--config "$(CONFIG)")
