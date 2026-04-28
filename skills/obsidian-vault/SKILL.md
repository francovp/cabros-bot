# obsidian-vault

Interactúa con los vaults de Obsidian del usuario ubicados en `~/OneDrive/obsidian-vault`. La vault por defecto es `~/OneDrive/obsidian-vault/personal`, pero el usuario puede especificar otras vaults si las tiene configuradas.

## Uso

- **Leer notas:** Usa la herramienta `read` con la ruta absoluta al archivo markdown.
  - Ejemplo: `read path="~/OneDrive/obsidian-vault/personal/Notas/Reunion.md"`
- **Escribir/Editar notas:** Usa la herramienta `write` para crear o sobrescribir, o `edit` para cambios puntuales.
  - Ejemplo (crear): `write path="~/OneDrive/obsidian-vault/personal/Notas/Nueva.md" content="# Título\nContenido..."`
  - Ejemplo (editar): `edit path="~/OneDrive/obsidian-vault/personal/Notas/Existente.md" edits=[{oldText: "Viejo", newText: "Nuevo"}]`

## Notas

- No uses `obsidian-cli`.
- Asegúrate de respetar la estructura de carpetas del vault si el usuario te da pistas sobre dónde guardar ciertas notas.
- Si el usuario no especifica una ruta, pregunta o sugiere una ubicación lógica dentro del vault.
