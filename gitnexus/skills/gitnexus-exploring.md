---
name: gitnexus-exploring
description: "Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: \"How does X work?\", \"What calls this function?\", \"Show me the auth flow\""
---

# Exploring Codebases with GitNexus

## When to Use

- "How does authentication work?"
- "What's the project structure?"
- "Show me the main components"
- "Where is the database logic?"
- Understanding code you haven't seen before

## Routing: Name vs Concept

Before starting, determine what the user gave you:

| Input looks like | Example | Start with |
|---|---|---|
| Symbol name (PascalCase, BP_, ST_, U, A prefix) | `BP_MainCharacter`, `UCompanionComponent` | **`gitnexus_context`** (step 2) |
| Concept or question | "how does damage work?", "AGLS traversal" | **`gitnexus_query`** (step 1) |

## Workflow

```
1. gitnexus_query({query: "<concept>"})              → Find related execution flows
2. gitnexus_context({name: "<symbol>"})               → Deep dive on specific symbol
3. READ gitnexus://repo/{name}/process/{name}         → Trace full execution flow
4. Check Blueprint connections (see below)            → Bridge C++ ↔ Blueprint
5. Read source files for implementation details
```

> If "Index is stale" → run `npx gitnexus analyze` in terminal.

## Step 4: Blueprint Connections

After finding C++ symbols, check if any Blueprint assets connect to them. This bridges the C++ ↔ Blueprint boundary that query() alone cannot cross.

```cypher
# Find Blueprints that extend or call a C++ symbol
MATCH (b:Blueprint)-[r:CodeRelation]->(n)
WHERE n.name = '<symbol_name>'
RETURN b.name AS blueprint, r.type AS relationship, b.filePath AS path
```

Run this for key C++ classes/functions found in earlier steps — especially base classes (ACharacter, UActorComponent subclasses) and UFUNCTIONs. This reveals which Blueprint assets use the C++ code.

To explore in the other direction (what C++ a Blueprint calls):
```cypher
MATCH (b:Blueprint {name: '<blueprint_name>'})-[r:CodeRelation]->(n)
RETURN n.name AS target, r.type AS relationship, labels(n) AS type
```

## Checklist

```
- [ ] Route: name → context(), concept → query()
- [ ] gitnexus_query for the concept (if applicable)
- [ ] gitnexus_context on key symbols for callers/callees
- [ ] READ process resource for full execution traces
- [ ] Check Blueprint connections for C++ symbols found
- [ ] Read source files for implementation details
```

## Resources

| Resource                                | What you get                                            |
| --------------------------------------- | ------------------------------------------------------- |
| `gitnexus://repo/{name}/context`        | Stats, staleness warning (~150 tokens)                  |
| `gitnexus://repo/{name}/clusters`       | All functional areas with cohesion scores (~300 tokens) |
| `gitnexus://repo/{name}/cluster/{name}` | Area members with file paths (~500 tokens)              |
| `gitnexus://repo/{name}/process/{name}` | Step-by-step execution trace (~200 tokens)              |

## Tools

**gitnexus_query** — find execution flows related to a concept:

```
gitnexus_query({query: "payment processing"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**gitnexus_context** — 360-degree view of a symbol:

```
gitnexus_context({name: "validateUser"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (step 2/5), TokenRefresh (step 1/3)
```

## Example: "How does the AGLS traversal system work?"

```
1. gitnexus_query({query: "AGLS traversal locomotion"})
   → Processes: CharacterMovement, AnimationUpdate
   → Symbols: ULocomotionComponent, TraversalAction, ...

2. gitnexus_context({name: "ULocomotionComponent"})
   → Incoming: ABaseCharacter::SetupComponents
   → Outgoing: StartTraversal, UpdateTraversalState

3. Check Blueprint connections:
   MATCH (b:Blueprint)-[r:CodeRelation]->(n)
   WHERE n.name = 'ULocomotionComponent'
   RETURN b.name, r.type, b.filePath
   → BP_MainCharacter EXTENDS ABaseCharacter
   → BP_MainChar_AGLS EXTENDS ...

4. Read source files for implementation details
```
