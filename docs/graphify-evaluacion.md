# Evaluación de `graphifyy` — auditoría de seguridad y protocolo de prueba

**Fecha:** 2026-07-27 · **Versión auditada:** 0.9.28 (wheel de PyPI)
**Alcance:** ¿es seguro instalarlo? ¿cómo medimos su impacto real sin arriesgar la operación?

---

## 1. Veredicto de seguridad: **APTO, con condiciones**

Auditoría hecha sobre el artefacto real descargado de PyPI (`pip download --only-binary=:all:`,
sin ejecutar código de instalación), más una ejecución aislada en un venv desechable.

### Evidencia verificada

| Control | Resultado |
|---|---|
| Publisher / licencia | Graphify Labs, Apache-2.0, repo `Graphify-Labs/graphify` |
| Formato | Wheel `py3-none-any` — sin `setup.py`, sin scripts de post-install |
| `eval` / `exec` / `os.system` / `pickle.loads` | **Cero ocurrencias** en 80 archivos `.py` |
| Telemetría (posthog/sentry/segment/mixpanel) | **Ninguna.** Postura "no-telemetry" explícita en el código |
| Dependencias base | Solo `networkx`, `numpy`, `rapidfuzz` + gramáticas tree-sitter. Reputadas |
| SDKs de LLM (`anthropic`, `openai`, `boto3`) | **Opcionales** (extras), no se instalan por defecto |
| URLs codificadas | Solo APIs de proveedores LLM que tú configuras, CDNs dentro del HTML generado, y `localhost`. **Ningún endpoint propio del vendor** |
| Módulo `security.py` (460 líneas) | Validación de URL, bloqueo de IP privadas/loopback/link-local, bloqueo de endpoints de metadata cloud, protección anti DNS-rebinding, topes de tamaño, guardas de path traversal, sanitización de metadata |
| Log de consultas | **Apagado por defecto**; si se activa, escribe solo en local |
| Variables de entorno leídas | Todas legítimas: config de proveedores LLM y sus propias `GRAPHIFY_*` |

La existencia de un módulo de seguridad dedicado, con protección anti DNS-rebinding y bloqueo de
`169.254.169.254`, indica madurez de ingeniería muy por encima del promedio de un proyecto 0.9.x.

### Prueba de comportamiento (repo real, copia desechable)

```
graphify extract demo --code-only
→ 0.55 s, sin API key, sin red
→ 74 nodos, 107 aristas, 10 comunidades desde 5 archivos de código
→ "1 file(s) skipped as potentially sensitive": .env.example
```

**Omitió `.env.example` por sí solo.** En un repo con `OPENAI_API_KEY`, `BRIDGE_SECRET` y
credenciales de Twilio, eso importa: la protección de secretos no es solo una promesa del README,
se observa en ejecución.

### Condiciones para aprobar

1. **Instalar solo `graphifyy`** (doble `y`). `pypi.org/project/graphify` devuelve 404 — si algún
   día aparece, es typosquat. Confirmar publisher = Graphify Labs.
2. **Usar `--code-only`** en la prueba: AST local, sin API key, sin egreso de datos.
3. **No instalar el hook `PreToolUse`** en la fase inicial (ver §2.1).
4. **Fijar la versión** (`graphifyy==0.9.28`). El proyecto publicó 0.9.27 y 0.9.28 en días
   consecutivos; no queremos que una versión nueva entre a mitad de la medición.

---

## 2. Riesgos identificados

### 2.1 El hook `PreToolUse` es invasivo — ALTO (evitable)

Son **dos comandos distintos**, y la diferencia es crítica:

| Comando | Qué hace | Riesgo |
|---|---|---|
| `graphify install --platform claude` | Copia el skill + sección en `CLAUDE.md` | Bajo |
| `graphify claude install` | Lo anterior **+ hook `PreToolUse`** | Alto |

El hook se registra con matchers `Bash\|Grep` y `Read\|Glob`: se interpone en **toda** búsqueda y
lectura de archivos del agente. En modo `--strict` llega a **bloquear** la primera lectura cruda de
cada sesión.

Mitigaciones que sí trae (verificadas en código): bloquea como máximo una vez por sesión
(`O_EXCL`, "an agent can never be stranded"), kill switch por `GRAPHIFY_HOOK_STRICT=0`, timeouts
con watchdog, diseño fail-silent.

Aun así: **timeout de rebuild por defecto = 600 s.** Un rebuild atascado puede colgar el flujo de
trabajo diez minutos. Si se activa el hook, bajar `GRAPHIFY_REBUILD_TIMEOUT` a 60–90 s.

### 2.2 El install es GLOBAL, no por proyecto — MEDIO

`graphify install --platform claude` **no escribe en el proyecto**. Escribe en `~/.claude/`:

```
~/.claude/skills/graphify/SKILL.md
~/.claude/skills/graphify/references/*
~/.claude/CLAUDE.md          ← creado si no existía
```

Verificado en vivo: tras el install, el skill quedó registrado de inmediato en la sesión en curso.

**Consecuencia directa para la prueba:** no se puede tener un proyecto de control mientras el
tratamiento está instalado — contamina todos los proyectos a la vez. Por eso el protocolo de §3
mide **antes → instalar → después**, no A/B en paralelo.

### 2.3 `uninstall` deja basura — BAJO (pero real)

Reproducido: `graphify uninstall` borró el skill pero **dejó la sección `graphify` en el
`~/.claude/CLAUDE.md` global**, porque solo busca `CLAUDE.md` en el directorio actual, no en el
directorio global donde el propio install lo escribió.

```
skill removed    ->  /root/.claude/skills/graphify/SKILL.md
No CLAUDE.md found in current directory - nothing to do   ← pero sí lo había creado en ~/.claude/
```

Queda una referencia colgada a un skill inexistente, inyectada en el contexto de todas las
sesiones. **El rollback exige un paso manual** (ver §4).

### 2.4 El benchmark propio usa una línea base falsa — ALTO (riesgo de decisión)

Esto es lo más importante del análisis. Ejecutado sobre este repo:

```
Corpus:          3,700 words → ~4,933 tokens (naive)
Avg query cost:  ~269 tokens
Reduction:       18.3x fewer tokens per query
```

El "18.3x" compara contra **releer el corpus completo en cada pregunta**. Ningún agente hace eso:
Claude Code busca con grep y lee selectivamente. La línea base es un hombre de paja, y explica la
distancia entre el "71x" del marketing y el ~6% del único test independiente
(113.000 vs 120.000 tokens).

Peor: al correr una consulta **real** sobre este repo —

```
graphify query "how does the twilio audio stream reach openai realtime"
→ 44 nodos, TRUNCADO en el tope de 2000 tokens
→ devuelve nombres de función y números de línea, sin código
```

La consulta costó **2000 tokens y aun así hay que leer `server.js`** para responder. Neto:
peor que no usarlo. **Nunca decidir con el `benchmark` del vendor. Solo con tokens medidos de punta a punta.**

### 2.5 Este repo es demasiado pequeño — determinante

| Métrica | Valor |
|---|---|
| Archivos versionados | 13 |
| `server.js` | 758 líneas |
| Código + docs | ~50 KB ≈ **~13k tokens** |
| Corpus según graphify | ~4.933 tokens |

El repo entero cabe en contexto de una sentada. **Aquí no hay nada que optimizar.**
La prueba debe correr en **`wamkt-notsy`**, el repo grande.

---

## 3. Protocolo de prueba ágil controlada

**Objetivo:** decidir con datos si graphify reduce el costo real de desarrollo en `wamkt-notsy`.
**Duración:** ~2 h de trabajo efectivo. **Costo en API:** $0 (todo con `--code-only`).

### Fase 0 — Preparación (15 min)

```bash
uv tool install graphifyy==0.9.28     # o pipx install graphifyy==0.9.28
graphify --version                     # debe decir 0.9.28
```

Congelar el terreno de prueba:
- Rama dedicada en `wamkt-notsy`, sin cambios de código durante la medición.
- Añadir `graphify-out/` al `.gitignore`.
- Verificar que `.env` y similares aparezcan como *skipped as potentially sensitive*. Si algún
  archivo con secretos **no** se omite, abortar.

### Fase 1 — Línea base SIN graphify (40 min) ← *va primero, obligatorio*

El install es global (§2.2): una vez instalado ya no hay control limpio. **Medir antes.**

Elegir **5 tareas reales y representativas** del trabajo cotidiano — no preguntas de juguete.
Ejemplos del dominio:
1. "¿Dónde se valida `BRIDGE_SECRET` y qué pasa si falta?"
2. "Agrega un campo nuevo al payload del webhook de outcome."
3. "¿Por qué el pool puede quedar en 0/2 y qué lo repone?"
4. "Traza el flujo completo de una llamada desde `/voice/connect` hasta `registrar_resultado`."
5. Un bug real pendiente del backlog.

Por cada tarea, sesión **nueva y limpia**, y registrar:

| Campo | Cómo se obtiene |
|---|---|
| Tokens totales | `/cost` al terminar la sesión |
| Tiempo de reloj | Cronómetro |
| ¿Respuesta correcta? | Juicio humano: sí / parcial / no |
| Nº de tool calls | Conteo aproximado en el transcript |

### Fase 2 — Instalación mínima (10 min)

```bash
cd ~/wamkt-notsy
graphify extract . --code-only        # local, sin API key, sin red
graphify install --platform claude    # skill SOLO — NO uses `graphify claude install`
```

Sin hook en esta fase. Queremos medir el valor del **grafo**, no el del hook. Si el grafo no
aporta, el hook tampoco lo salvará y solo añade riesgo.

### Fase 3 — Repetición CON graphify (40 min)

Las **mismas 5 tareas**, sesiones nuevas y limpias, mismas métricas. Instruir explícitamente al
agente a consultar el grafo primero (`/graphify` o `graphify query`).

### Fase 4 — Decisión

Comparar tokens, tiempo y correctitud, tarea por tarea.

**Criterios — acordarlos ANTES de ver los resultados:**

| Resultado | Decisión |
|---|---|
| ≥30% menos tokens **sin** perder correctitud | Adoptar. Evaluar el hook como fase 2 |
| 10–30% menos tokens | Zona gris. Adoptar solo si el tiempo también baja |
| <10%, o alguna respuesta empeora | **Descartar.** Ejecutar rollback (§4) |
| Cualquier respuesta correcta se vuelve incorrecta | **Descartar de inmediato**, sin importar el ahorro |

Regla dura: **un ahorro de tokens que degrada la calidad de las respuestas no es un ahorro**, es
trasladar el costo a depurar código malo. En un sistema que atiende llamadas de clientes en
producción, ese intercambio no compensa.

---

## 4. Rollback completo

```bash
cd ~/wamkt-notsy
graphify uninstall --purge          # quita skill + borra graphify-out/

# PASO MANUAL OBLIGATORIO (bug §2.3): el uninstall no limpia el CLAUDE.md global
grep -n graphify ~/.claude/CLAUDE.md
# borrar a mano la sección "# graphify" (si el archivo quedó SOLO con eso, eliminar el archivo)

uv tool uninstall graphifyy         # o: pipx uninstall graphifyy / pip uninstall graphifyy

# verificación final — no debe devolver nada:
grep -rl graphify ~/.claude/ --exclude-dir={projects,sessions,shell-snapshots} 2>/dev/null
```

---

## 5. Resumen ejecutivo

- **¿Es seguro?** Sí. Apache-2.0, sin telemetría, sin ejecución dinámica de código, dependencias
  limpias, seguridad bien pensada, y omite archivos con secretos por sí solo. Es el vector de
  riesgo bajo de esta evaluación.
- **¿Sirve?** Sin decidir — y esa es la pregunta que importa. El "71x" y el "18.3x" están
  construidos sobre una línea base irreal. La única evidencia independiente apunta a ~6%.
- **¿Dónde?** En `wamkt-notsy`, nunca en este repo (~13k tokens totales: no hay nada que ahorrar).
- **¿Cómo?** `--code-only`, sin hook, línea base primero, criterios de descarte fijados de
  antemano. Costo $0.
