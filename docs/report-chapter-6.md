# Chapter 6 — Key Design Decisions

Every system reflects a sequence of design decisions, and the quality of the system depends as much on the soundness of those decisions as on the cleanliness of their implementation. The preceding chapters described what the system does and how it is constructed; this chapter examines five specific decisions in detail, presenting for each one the alternative that was considered and rejected, the analysis that drove the rejection, the trade-offs that were accepted, and the conditions under which the decision might reasonably be revisited in a future iteration of the system.

The five decisions discussed in this chapter are not the only design choices the system embodies, but they are the ones that most distinguish this system from a naive implementation that would have produced superficially similar functionality. The decision to keep large-language-model calls off the request path, the decision to run text embeddings on local infrastructure rather than via remote APIs, the decision to derive load from the assignment table rather than maintain a counter column, the decision to share a single feature-construction module between training and inference paths, and the principle of graceful degradation under absent inputs — each represents a place where the obvious alternative would have been faster to build but slower, less reliable, less private, less correct, or less robust in production. Documenting them in this depth is the principal way the report defends the engineering effort that went into each.

The chapter is the longest and most argumentative in the report. Where earlier chapters described mechanism, this chapter argues for choices. Each section is structured as a small piece of engineering writing in its own right, with a clearly stated decision, a development of the analysis, and a forward-looking section identifying when the conclusion might shift. Examiners who wish to interrogate the system's design most rigorously will find the material in this chapter most amenable to interrogation.

---

## 6.1 Deterministic Routing over LLM-on-Request-Path

### 6.1.1 The Decision

The routing agent does not invoke any large language model during its execution. The score for each candidate is computed by a deterministic function of six numerical features, and the choice between candidates is made by comparing these scores. The only language-model invocations on the request path are upstream of the routing agent, in the classification stage, where free-text problem descriptions must be converted into structured fields. After the routing agent commits its decision, an asynchronous explainer agent invokes a language model to produce a human-readable rationale, but this invocation runs in a background task that does not block the user's response.

The decision has two practical consequences. The first is that ticket creation completes in approximately one to two seconds at the ninety-fifth percentile, dominated by the single Gemini call to the classification agent. The second is that an outage of the language-model provider does not prevent ticket creation from succeeding: the classification agent falls back to a keyword-based heuristic, the routing agent runs on its deterministic features regardless of model availability, and the asynchronous explainer simply queues its work for processing when the model becomes available again.

### 6.1.2 The Rejected Alternative

The obvious alternative — the one that would have been the natural choice without the analysis presented below — is what may be called LLM-driven agentic routing. Under this design, the routing decision would be made by a language model that receives the ticket description, the candidate list, and additional contextual information, and produces a recommendation along with a written rationale in a single call. A natural framework for such a design is LangGraph, the state-machine library already used elsewhere in the codebase by the escalation agent, which provides primitives for tool-using agents that iterate over a sequence of model calls and external lookups before producing a final output.

A LangGraph-driven routing agent would have several superficial appeals. It would be flexible, able to accommodate new criteria simply by adding to the prompt rather than by changing scoring code. It would be self-documenting, in the sense that the model's intermediate reasoning would be visible in the agent's internal state. And it would feel more sophisticated than a hand-tuned weighted sum, which has the appearance of engineering antiquity in an era of model-driven systems.

The system rejects this design for reasons that are individually significant and collectively decisive. Each is developed below.

### 6.1.3 The Latency Analysis

A LangGraph-driven routing agent would necessarily make at least one language-model call on the request path, and in practice would make several: a query for the initial assessment, possibly a follow-up tool call to fetch additional candidate information, and a final selection call. Each Gemini 1.5 Flash call takes approximately one second on average, with substantially longer tail latencies driven by network jitter, model queueing, and occasional retries on transient errors.

A single-call agent would push request-path latency from approximately one second (the current classification call) to approximately two seconds (classification plus a single routing call) at the median, with the ninety-fifth percentile rising correspondingly. A multi-call agent — the more flexible variant that could perform tool-using lookups during its reasoning — would push median latency to five to ten seconds, with tail latencies in the thirty-second range. Such latencies are unacceptable for a synchronous user-facing operation. A store register submitting a maintenance ticket reasonably expects a response within a few seconds; a five-second response is perceptibly slow, and a thirty-second response would be interpreted as a system failure.

The deterministic routing agent's request-path contribution, in contrast, is approximately fifty milliseconds — dominated by the database queries it performs (the routing decision log write, the assignment row write, and the ticket status update) rather than by computation. This leaves the bulk of the latency budget available to the classification call, which cannot be easily moved off the request path because its output is required for the routing decision itself. The asymmetry between classification (LLM-required because the input is unstructured text) and routing (LLM-optional because the input is already structured features) is the foundational insight that motivates the deterministic design.

**Figure 6.1 — Latency budget comparison** *(to be rendered as a stacked horizontal bar chart with two bars)*. The figure should show two horizontal bars representing the two architectural alternatives. The upper bar represents the deterministic-routing design with segments for classification (~1000ms), routing computation (~50ms), and persistence (~50ms), totaling approximately 1100ms with a tail latency annotation showing p95 ≈ 1800ms. The lower bar represents the LLM-driven routing design with segments for classification (~1000ms), routing LLM call (~1000ms), tool-use overhead (~500ms), and persistence (~50ms), totaling approximately 2550ms with a tail latency annotation showing p95 ≈ 8000ms. The figure should make visually explicit that the deterministic design preserves a sub-two-second user-facing latency budget while the LLM-driven design does not.

### 6.1.4 The Availability Analysis

The latency analysis is the most quantifiable argument against LLM-on-request-path routing, but it is not the most important. The more significant concern is availability: a routing agent that depends on a language-model provider for its operation cannot be more available than that provider, and language-model providers in their current state are not engineered for the availability standards of operational dispatch systems.

Concretely, Google's Gemini API has experienced documented outages and rate-limit incidents during the system's development period, and similar outages affect every major language-model provider. An LLM-driven routing agent during such an outage would be unable to make routing decisions; tickets would queue up unassigned, and the operational impact would compound as the queue grew. The current architecture handles such outages without any user-visible degradation: the classification fallback produces a heuristic classification, the routing agent runs on its deterministic features, and tickets are assigned exactly as they would be during normal operation. Only the asynchronous explanations are delayed, and those have no operational consequence beyond an empty audit trail.

The availability argument is sometimes dismissed on the grounds that language-model providers are improving and outages are becoming rarer. This argument, while accurate as a description of trend, is not adequate as a basis for system design. An operational system must be defensive against the failure modes that actually occur, not against an idealized version of the dependencies it relies on, and the time at which language-model providers achieve five-nine availability is not yet here.

### 6.1.5 The Cost Analysis

A third and quantifiable argument against LLM-on-request-path routing is direct cost. Each Gemini 1.5 Flash call has a non-zero monetary cost, and the cost compounds linearly with ticket volume. The current architecture spends one such call per ticket on classification; an LLM-driven routing agent would spend two to four calls per ticket, depending on its sophistication. At anticipated production volumes, this multiplier translates into a meaningful difference in operational cost over a fiscal year — a difference that, while not the dominant consideration, is non-trivial and is borne by the operator rather than by a research budget.

The asynchronous explainer agent does invoke a language model per assignment, contributing to the cost, but this contribution is bounded by the assignment volume rather than by the routing volume, and it is a deliberate choice to incur the cost in exchange for the audit-trail benefit.

### 6.1.6 The Failure-Mode Analysis

The latency, availability, and cost arguments collectively establish that LLM-on-request-path routing is the wrong default for an operational system, but they do not exhaustively describe the failure modes that the deterministic design avoids. A more thorough enumeration is useful because it makes explicit the categories of failure that a more LLM-driven design would have to defend against.

A language-model call can fail in several distinct ways. The model may return malformed output that fails schema validation, requiring the agent to either retry (compounding latency) or fall back to a deterministic alternative (which then becomes a parallel implementation that must be maintained). The model may time out, requiring the agent to decide between waiting longer (compounding latency) and abandoning the call (which then requires fallback). The model may be rate-limited, requiring the agent to either back off (which delays the routing decision) or fall back. The model may produce a response that is structurally valid but operationally incorrect, recommending a candidate that lacks the relevant skills or that has insufficient capacity; this failure mode is the most insidious because it is invisible to schema validation and would only be detectable by post-hoc analysis. Each of these failure modes requires either explicit handling code or an acceptance of degraded behaviour, and the cumulative complexity of handling them well is substantial.

The deterministic design has none of these failure modes. The score function is a pure mathematical computation that is correct by construction — it returns the same result for the same input every time, and any errors in its implementation can be detected and fixed in unit tests rather than discovered through outcome analysis.

### 6.1.7 What Is Given Up

The deterministic design surrenders three properties that the LLM-driven alternative would have provided.

The first is interactive flexibility. Adding a new consideration to the LLM-driven agent's decision can be done by editing the prompt, while the deterministic agent requires writing code, computing a new feature, and integrating it into the score formula. The deterministic agent is therefore less flexible to short-term changes in operational requirements.

The second is generalization to novel cases. The deterministic agent's score formula reflects assumptions made by its designer at the time of construction; if a category of ticket appears that violates these assumptions, the agent has no graceful way to adapt. The LLM-driven agent, by contrast, may handle the novel case reasonably simply because the underlying model has broader training data than the score formula's designer.

The third is explainability of the decision itself. The deterministic agent can explain why a candidate was selected by reporting its feature values and weights, but cannot explain why those features and weights are the correct basis for the decision. The LLM-driven agent can produce a fluent natural-language rationale that synthesizes operational considerations into a single narrative.

The system mitigates these losses through specific architectural choices. The score formula is intentionally compact and inspectable, so that adding a feature is a manageable engineering task rather than a significant rewrite. The exploration mechanism described in Chapter 4 partially addresses generalization by ensuring that novel cases occasionally trigger non-greedy selections whose outcomes can inform future feature engineering. And the asynchronous explainer agent provides the natural-language rationale that the deterministic agent cannot, with the rationale produced post-hoc rather than as a determinant of the decision.

### 6.1.8 When the Decision Might Be Revisited

Three developments would change the calculus and justify reconsidering LLM-on-request-path routing.

The first is a substantial improvement in language-model latency. If models that produce responses in tens of milliseconds become available — for instance, through smaller models running on local accelerator hardware, or through provider-side optimizations such as speculative decoding — the latency argument against LLM-on-request-path routing weakens correspondingly. At sub-hundred-millisecond inference times, the latency cost of an LLM call becomes comparable to the database queries the system already performs.

The second is the maturation of language-model availability guarantees. If a provider offers a service-level agreement with availability above ninety-nine and a half percent backed by enforceable penalties, the availability argument weakens proportionally. This development is plausible but not yet present in the language-model market.

The third is the emergence of on-premise or self-hosted language models with operational characteristics suitable for production routing. Such models would eliminate the network dependency entirely and would bring language-model inference under the same operational control as the database. The trajectory of open-weight models suggests that this development is reasonably foreseeable in a multi-year horizon.

In any of these scenarios, the deterministic-routing decision should be re-examined. In the meantime, the architecture is structured so that the change can be made by replacing the score-computation step rather than by re-architecting the surrounding components. The routing agent's score function is a single method; replacing it with a language-model call would not require changes to the candidate-selection logic, the persistence sequence, or the exploration mechanism.

---

## 6.2 Local Embeddings for PII Safety

### 6.2.1 The Decision

The system computes text embeddings using the open-weight `bge-small-en-v1.5` model running locally in-process via the `@xenova/transformers` library. No ticket text, no technician resolution notes, no asset descriptions, and no other text generated by the application is sent to a third-party embedding service for vector computation. The model executes within the Node.js runtime that hosts the application itself, with model weights cached on the application's filesystem after first use.

This decision affects the system's privacy profile, its operational dependencies, and its embedding-related latency characteristics. Each is examined below.

### 6.2.2 The Rejected Alternative

The natural alternative — and the one that requires no additional dependency — is to use Google's Gemini text-embedding API, which produces vectors of comparable quality and integrates with the same SDK already used by the classification and explainer agents. A typical implementation would issue an HTTP request per text input, receive a vector in response, and write the vector to the appropriate database column. This approach would eliminate the need for the local model file and would offload the inference cost to the embedding provider's infrastructure.

### 6.2.3 The Privacy Analysis

The decisive consideration against the remote-embedding alternative is the content of the text being embedded. The embedding pipeline processes three categories of text: ticket descriptions submitted by store registers, resolution notes written by technicians, and asset descriptions optionally captured during asset enrichment. Each of these categories may contain personally identifying information.

Ticket descriptions are typically the most sensitive. A store register reporting a maintenance issue may identify the customer who reported the problem ("Mrs. Patel from aisle four reported the freezer is leaking"), the employee involved ("the night-shift manager said this happened around 2 AM"), or operational details about the store that constitute non-public information ("the back office cooler that holds the weekly inventory is failing"). These details are captured incidentally — store registers are not asked to anonymize their descriptions, and asking them to would slow ticket entry without operational benefit — but they are present nonetheless.

Resolution notes written by technicians may be even more sensitive. A technician completing a repair may record details about the equipment ("the manager Mr. Sharma showed me the failure logs"), about the operational context ("the store reported a customer slip-and-fall earlier this week related to this leak"), or about the physical premises ("the access panel in the manager's office had to be removed to reach the unit"). These are exactly the kinds of details that allow the embedding to capture meaningful technical context, but they are also exactly the kinds of details that should not be transmitted to a third-party service.

Sending such text to a remote embedding API constitutes a transfer of personal data to a third party, and the system's data-residency story would have to account for it explicitly. The third party's data-handling policies, retention practices, and downstream uses (including potential use as training data for future model versions) all become part of the privacy posture of the system. While reputable providers offer contractual commitments around these matters, those commitments still increase the surface area of the privacy story and may not align with the residency requirements that customer-facing operators are subject to.

The local-embedding design eliminates this transfer entirely. The text never leaves the application's runtime, and the embedding vectors that are stored in the database are produced by a model that is itself local. The data-residency story is therefore unchanged from a system that did no embedding at all: only the database, the application server, and the user's browser ever see the text.

### 6.2.4 The Operational Analysis

The privacy argument is decisive on its own, but two additional operational arguments support the local-embedding decision.

The first is dependency reduction. A remote embedding API adds another external service to the system's dependency graph, with corresponding implications for availability, rate limits, and cost. Each ticket creation, each moderator verification (which triggers a skill-embedding refresh), and each asset enrichment would generate at least one embedding API call, and outages or rate-limit incidents would propagate through these paths. The local-embedding design has none of these failure modes — the embedding pipeline either succeeds (when the model is loaded) or fails locally, and the failures are attributable to the application's own runtime rather than to an external provider.

The second is latency. Network round-trips to a remote embedding API typically take one to two hundred milliseconds at the median, with substantially longer tails. The local embedding pipeline runs in approximately thirty milliseconds once the model is warm. While the asynchronous nature of the embedding writes means that this latency is not user-visible in most cases, it does constrain the rate at which embeddings can be refreshed during operational bursts (for instance, when a backlog of moderator verifications is processed in succession). The local pipeline scales horizontally with the number of application processes, while the remote pipeline scales by the provider's rate limits.

### 6.2.5 The Quality Analysis

A common objection to using smaller open-weight models such as `bge-small-en-v1.5` is the assumption that proprietary commercial embeddings are higher quality. This assumption deserves explicit examination.

The MTEB benchmark, which evaluates embedding models on a broad suite of retrieval, classification, and clustering tasks, places `bge-small-en-v1.5` competitively with significantly larger models including the major commercial offerings. Specifically, on retrieval tasks involving short technical text — the task most analogous to the system's use case — bge-small produces results within approximately three percentage points of much larger models. The quality cost of the local model is real but modest, and is more than offset by the privacy and operational benefits.

For tasks involving very long documents or highly specialized domains, the quality gap would widen. Maintenance-ticket text is short (typically a few sentences) and uses operationally specific vocabulary that is well-represented in the bge model's training data, so the use case sits firmly in the model's strong region. A future expansion that involved embedding longer-form content (for instance, full incident reports or extensive technical documentation) might justify reconsidering the model choice, but such an expansion is not currently contemplated.

### 6.2.6 The Resource Analysis

The local-embedding design imposes resource costs on the application's hosting environment. The model file is approximately thirty megabytes on disk, cached after first use. The model's memory footprint during inference is approximately one hundred megabytes, which coexists with the rest of the Node.js runtime. The first invocation after process startup takes approximately two seconds while the model is loaded; subsequent invocations take approximately thirty milliseconds.

These costs are small relative to the application's overall resource consumption. The Node.js runtime itself uses several hundred megabytes of memory before any application-specific code runs, and the database connection pool and the framework's caches consume comparable amounts. The thirty-megabyte model file is substantially smaller than typical npm dependencies, and the two-second cold-start cost is amortized across all subsequent embedding invocations within the same process.

The resource costs become more significant in deployment environments that aggressively scale down idle processes — for instance, serverless functions that may experience cold starts on every invocation. In such environments, the two-second cold-start cost becomes operationally visible. The system's current deployment model uses long-running processes that warm up once and then remain warm for the lifetime of the deployment, so this cost is paid only at deployment time. A future migration to a serverless deployment model would require additional thought on this dimension.

### 6.2.7 When the Decision Might Be Revisited

The local-embedding decision rests on a specific privacy posture and a specific quality threshold. Two developments would justify revisiting it.

The first is a remote embedding service that offers genuine on-premise or zero-data-retention guarantees, with contractual commitments backed by audit. Some providers have begun offering such tiers for enterprise customers, and as these offerings mature, the privacy argument against remote embeddings weakens. The argument does not vanish — the operational dependency cost remains — but it becomes a matter of trade-off rather than of safety.

The second is a substantial widening of the quality gap between local and remote embeddings. If commercial offerings produce embeddings that are materially better for the specific use case of technical short-text retrieval, the operational benefit of better routing decisions might outweigh the privacy and dependency costs. This development would need to be measured rather than assumed; the current best evidence places the gap as small for this use case.

Until either development materializes, the local-embedding design is the sound choice and should be retained.

---

## 6.3 Query-Derived Load vs Counter-Based Tracking

### 6.3.1 The Decision

The provider-load count used by the availability agent's capacity filter and by the routing agent's availability feature is computed live by aggregating over the `TicketAssignment` table at each invocation. Specifically, the availability agent issues a single `GROUP BY` query that counts active assignment rows per provider:

```sql
SELECT service_provider_id, COUNT(*)
FROM ticket_assignments
WHERE status IN ('PROPOSED', 'ACCEPTED')
GROUP BY service_provider_id;
```

The result is a map from provider identifier to the count of active assignments. The `ServiceProvider.current_load` integer column, which had been the load-tracking mechanism in the legacy system, is no longer mutated by application code; it remains in the schema for backward compatibility but its value is not consulted by the routing path.

### 6.3.2 The Rejected Alternative

The legacy design — and the design that is the most natural first solution to the load-tracking problem — is to maintain a counter column on the `ServiceProvider` table that is incremented when an assignment is created and decremented when an assignment terminates (whether through acceptance, rejection, expiration, or completion). Reads of the load are direct column reads, which are constant-time operations that require no aggregation.

This design has the appeal of being conceptually simple and operationally cheap: the counter is updated in the same transactions that create and modify assignments, and the load value is available without any computation. It is the design that any introductory database textbook would suggest, and it was the design the system inherited.

### 6.3.3 The Failure-Mode Analysis

The counter-based design is correct only if the counter's value remains synchronized with the actual count of active assignments. Achieving and maintaining this synchronization in practice is more difficult than it appears, and the failure modes that arise from desynchronization are the central problem with the counter-based design.

In the legacy system, the counter was mutated from three distinct code paths: the routing agent incremented it after committing a new assignment, the orchestrator decremented it when handling a rejection, and the orchestrator decremented it again when handling a completion. Each of these mutations was performed in a separate Prisma operation that was not transactionally bound to the corresponding assignment-row write. The implications of this lack of transactional binding deserve careful examination.

Consider the following sequence of events during a routing decision:

1. The routing agent successfully writes the `TicketAssignment` row with status `PROPOSED`.
2. The application process crashes before the subsequent `current_load` increment executes.
3. The process restarts.

After this sequence, the database contains one more active assignment than the counter reflects. The counter is now permanently understated by one for that provider, and no subsequent operation will detect or correct the discrepancy. The provider will be considered to have one more unit of available capacity than they actually do, and over time the gap will grow as additional crashes or partial failures occur.

The same failure mode arises in less dramatic circumstances. A network failure between the application and the database during the load-update operation would leave the database in a state where the assignment row was written but the counter was not. A query that was logically grouped with the assignment write but executed in a separate transaction would have the same effect under transient database errors. Even a deployment that briefly ran two versions of the application code, with different load-update behaviour, could produce inconsistencies that no single version of the code would have produced.

The fundamental problem is that the counter is not the source of truth for the quantity it represents; it is a derived value that must be kept in sync with the source of truth (the set of active assignment rows) through application-level coordination. Application-level coordination is brittle in the presence of failures and is the wrong tool for this job.

### 6.3.4 The Derived-Query Design

The redesigned approach abandons the counter and computes the load value live from the assignment table on every read. The query is shown above; it is a single `GROUP BY COUNT` over the table, filtered by the active-status set. The result is correct by construction: the count is exactly the number of rows that match the filter at the moment the query executes.

This design has several important properties. The first is that there is no synchronization to maintain. The query reads the current state of the assignment table, and any operation that modifies the table (including failures that leave it in an inconsistent state from the counter's perspective) automatically affects the next query's result. There is no cached value that can drift.

The second is that the query's correctness does not depend on application-level coordination. Even if multiple application processes are concurrently writing assignments, the query's result reflects whatever state the database is in at query time. Concurrent writes may cause the result to differ between successive queries, but each individual result is still correct as of its query time.

The third is that the query benefits from standard database optimization. The `TicketAssignment` table has an index on `(service_provider_id, status)`, which makes the `GROUP BY` operation efficient: the index covers both the filter predicate and the grouping column, so the database can answer the query without table access. The query's cost is therefore proportional to the number of active assignments, not to the number of assignments in the entire table or to the number of providers.

### 6.3.5 The Cost Analysis

The derived-query design imposes one additional database query per ticket creation, compared to the counter-based design which read the value directly from a column already loaded as part of the provider record. In absolute terms, this additional query costs approximately five milliseconds at typical operational scales — a small fraction of the routing path's overall latency budget.

The cost grows slowly with the size of the assignment table: the index-supported `GROUP BY` is approximately logarithmic in the table size, so even at a million active assignments the query would complete in tens of milliseconds. At the system's anticipated scale of thousands of active assignments at most, the cost is essentially fixed.

The corresponding cost of the counter-based design is the silent drift problem: the cost is not paid in latency but in correctness, and it accumulates over time. At any given moment the counter-based design appears free, but its long-term operational cost is the gradual degradation of the load values' accuracy and the corresponding gradual degradation of the routing decisions that depend on them.

### 6.3.6 The Pattern: Events as Source of Truth

The query-derived load tracking is one instance of a more general pattern: events should be recorded as event rows, and quantities derived from events should be computed from those rows rather than maintained as separate state. This pattern appears in several places in the system. The ownership of a ticket is determined by the most recent active assignment row, not by a column on the ticket. The escalation history is recorded as escalation rows, not as state on the ticket. The historical performance of a provider is computed by aggregating outcomes, not by a precomputed score.

Each instance of this pattern has the same structure: the event rows are append-only, the derived quantities are computed by aggregation, and the system avoids the synchronization problems that arise from maintaining derived quantities as separate state. The trade-off is consistent across instances: each pattern requires one query per derived value but eliminates a class of synchronization bugs that would otherwise require careful application-level coordination.

This pattern is not new in software architecture — it is the foundation of event-sourced systems and is closely related to the principles of Command-Query Responsibility Segregation. The system does not adopt these patterns wholesale; it uses the pattern selectively where the synchronization risk is high and the aggregation cost is low. Load tracking is one such case, ownership is another, and several smaller cases exist throughout the schema.

**Figure 6.2 — The two designs side by side** *(to be rendered as a two-panel diagram)*. The left panel shows the legacy counter-based design with three arrows from different application code paths writing to a `current_load` column on the `service_providers` table, with a danger annotation indicating that any of these writes can fail and leave the counter inconsistent. The right panel shows the derived-query design with a single arrow from the availability agent issuing a `GROUP BY COUNT` query to the `ticket_assignments` table, with an annotation indicating that the query's result is correct by construction. The figure should make explicit that the derived-query design has a single read path replacing three write paths, with the correctness guarantee that all three writes were trying and failing to provide.

### 6.3.7 When the Decision Might Be Revisited

The derived-query design's principal limitation is its scaling profile under extremely high write rates. The query's cost grows logarithmically with the assignment table's size, which is acceptable up to operational scales of millions of rows but might become noticeable at substantially higher scales. At that point, materializing the load count (perhaps as a periodically-refreshed aggregate or as a maintained counter that is reconciled against the truth value on a schedule) might become a useful performance optimization.

Importantly, the redesigned approach to materialization would be different from the legacy counter-based design: it would treat the counter as a cache that is periodically validated against the source of truth, with reconciliation logic that detects and corrects drift. This is a substantially more complex design than either the pure derived-query approach or the legacy counter approach, and it should be undertaken only when the operational evidence supports the need for it.

Until that point, the derived-query design is the correct choice. Correctness is preserved by construction, the cost is small, and the operational simplicity of having only one path from event to derived value is itself a valuable property.

---

## 6.4 Train/Serve Consistency — Single Feature Builder

### 6.4.1 The Decision

The features used by the routing system are computed by a single TypeScript module — `lib/ai/training/feature-builder.ts` — that is invoked at both request time, by the routing agent or its eventual learned-ranker replacement, and at training time, by the offline data exporter that constructs training rows from the routing decision log. The same function, called with the same inputs, produces the same feature vector in both contexts.

This design choice has implications for code organization, deployment, and the prevention of a specific class of machine-learning bugs. The motivation and the trade-offs are examined below.

### 6.4.2 The Phenomenon Being Defended Against

The bug class the design is structured to prevent is known in the machine-learning literature as train/serve skew, and it is widely recognized as one of the most common silent failure modes of production machine-learning systems. The phenomenon arises when the feature values produced at training time differ from the feature values produced at serving time, not because the inputs differ but because the feature-construction code differs in some subtle way between the two paths.

Consider a hypothetical scenario in which the system computes a `distance_score` feature by normalizing a Haversine distance against a fifty-kilometre cap. At training time, this feature is computed in a Python notebook that the data scientist wrote, which uses `numpy.clip(distance, 0, 50)` to apply the cap. At serving time, the same feature is computed in the routing agent's TypeScript code, which uses `Math.max(0, Math.min(distance, 50))`. The two implementations are arithmetically equivalent for all positive distances, but they handle negative distances differently: numpy's clip would return zero, while the Math.max/min combination would also return zero. Now suppose a future change to the Haversine implementation introduces a numerical edge case where very-close coordinates produce slightly negative distances due to floating-point error. The training code, having used a single numpy call, continues to produce zero. The serving code, having used the Math composition, continues to produce zero as well.

Now consider the same scenario with a different boundary case. Suppose the Haversine implementation in training is replaced with a slightly different formula that, due to floating-point details, occasionally produces distances of `49.9999...` for what should be exactly fifty-kilometre points. The training feature is `1 - 49.9999 / 50 = 0.0000...`, a very small positive number. The serving feature, computed differently, returns exactly zero for the same logical inputs. The model, trained on tiny-but-nonzero values, has learned to expect them; at serving time it instead receives zeros. The model's predictions degrade in a way that no unit test would catch because each path is internally consistent.

This is the kind of bug that is silent, that takes weeks or months to diagnose, and that can be entirely prevented by ensuring there is exactly one implementation of each feature.

### 6.4.3 The Two Possible Architectures

There are two natural architectures for ensuring feature consistency between training and serving. The first is to share a single implementation between the two paths. The second is to maintain two implementations and ensure they remain consistent through testing.

The shared-implementation architecture has the advantage of being correct by construction: if the same code runs in both paths, the features cannot differ. Its disadvantage is that the two paths have different language and runtime contexts (the request-time path runs in Node.js as part of the application, while the offline training path may run in Python as part of the data pipeline), so sharing requires either constraining both paths to the same language or building a cross-language interface.

The dual-implementation architecture has the advantage of allowing each path to use its native language and tooling. Its disadvantage is that consistency is not guaranteed by construction; it must be enforced through tests that compare the two implementations' outputs on a shared set of inputs. These tests are easy to write but easy to forget to update, and the consistency guarantee is only as strong as the test suite's coverage.

The system adopts the shared-implementation architecture, with both paths invoking the same TypeScript module. The training path runs the data export and the feature construction in TypeScript via `npx tsx`, while the model training itself runs in Python on the resulting JSONL file. This split — features in TypeScript, model training in Python — is examined further below.

### 6.4.4 The Cross-Language Boundary

The choice to keep features in TypeScript while running the model training in Python introduces a cross-language boundary that requires careful design. The boundary is at the JSONL file produced by the exporter: the exporter runs `feature-builder.ts` to compute the feature vector for each training row, and it writes the result as JSON. The Python training script reads the JSON and consumes the features as a fixed-format array.

This design has an important property: the Python side never recomputes features. It treats the features as opaque numerical inputs and trains a model that maps those inputs to labels. There is no Python implementation of the feature builder, so there is no Python implementation that can drift from the TypeScript implementation. The single TypeScript module is the unambiguous source of truth for what each feature means and how each feature is computed.

The cost of this design is that any change to the feature set requires regenerating the training data. A new feature is not retroactively computable for historical decision-log rows unless the inputs to that feature were captured at decision time and stored in the log. This consideration motivates a related design decision: the routing decision log captures not only the chosen candidate's score but the full feature breakdown for the top five candidates, so that historical feature vectors can be reconstructed without re-running the feature builder against potentially-changed historical data.

### 6.4.5 The Storage Trade-Off

A subtle aspect of the train/serve consistency design is the trade-off between storage cost and reproducibility. The decision log captures the feature breakdown for each candidate, which inflates the log's storage cost by approximately the size of the breakdown JSON per candidate per decision. This cost is accepted in exchange for the property that historical decisions can always be replayed against the current model: even if the feature definitions change, the historical features as the decision was actually made are preserved.

An alternative would be to capture only the inputs to the feature builder (the candidate's raw data and the ticket's raw data) and to recompute the features on demand. This would reduce the log's storage cost but would make historical replay sensitive to feature-definition changes: a feature added today would not have been captured in last month's decisions, and any analysis comparing historical and current feature distributions would have to handle the mismatch.

The current design — capturing the computed features rather than the inputs — is more conservative, costing more in storage but providing stronger guarantees about historical analysis. The choice could be revisited if storage cost became a concern, but at the system's anticipated scale, it does not.

### 6.4.6 The Implementation Detail

The feature builder's implementation deserves brief examination because its specifics inform what kinds of features it can build. The module exposes a single function that takes a structured input describing the candidate, the ticket, and the contextual factors (priority, time of day, store location), and returns an object whose keys are feature names and whose values are the corresponding numerical values.

Adding a new feature requires three changes: extending the input type to include any new raw data the feature depends on, adding a key to the output type for the new feature name, and implementing the computation in the function body. All three changes are local to a single file, and the TypeScript compiler enforces consistency between the input type, the output type, and the implementation. The training pipeline picks up the new feature on its next run; the routing agent picks it up on its next deployment.

The Python side requires no corresponding change — the new feature appears as an additional key in the JSONL rows, and the training script reads it by name. This asymmetry (TypeScript changes everywhere, Python changes nowhere) is the operational benefit of the single-language feature definition.

### 6.4.7 What the Design Does Not Defend Against

The single feature-builder design defends against drift between training and serving feature implementations but does not defend against all forms of train/serve discrepancy. Two categories of discrepancy fall outside its scope.

The first is data distribution shift: even if features are computed identically, the distribution of feature values seen at serving time may differ from the distribution seen at training time. A model trained on data from one quarter and served on data from the next quarter may degrade simply because the underlying operational reality has shifted. This is addressed by the drift-monitoring infrastructure described in Chapter 5, not by the feature-builder design.

The second is model-input format drift: the model's input shape (the order and dimensionality of the feature vector) must match between training and inference. The system uses XGBoost's named-feature interface, which makes feature ordering robust to mismatches, but a future migration to a model architecture that uses positional features would require additional discipline.

These limitations are worth acknowledging because they make clear that the feature-builder design is a necessary but not sufficient defense against train/serve issues. The full defense requires the feature-builder design, the drift monitoring, and ongoing model evaluation against held-out data.

### 6.4.8 When the Decision Might Be Revisited

The feature-builder-in-TypeScript decision is well-suited to the current system's architecture, where the application is in Node.js and the request-time inference is therefore in Node.js. A future migration to a different runtime (for instance, if the routing logic moved to a Go service or a Rust service) would invalidate the assumption that TypeScript is the correct host language. In that scenario, the feature builder would need to move to the new language, and the existing design's value would be in establishing the precedent that there should be exactly one implementation rather than multiple language-specific ones.

A more dramatic revisitation would be triggered by a substantial increase in feature complexity. The current feature set is computable in TypeScript with no significant cost; if a future feature involved, for instance, complex tensor operations or specialized libraries available only in Python, the case for cross-language feature implementation would strengthen. At that point the design might evolve to a shared schema with language-specific implementations and rigorous cross-language equivalence testing — the dual-implementation architecture rejected above. The decision would shift because the cost-benefit calculation would shift.

For the current and foreseeable feature set, the single-TypeScript-module design is the correct choice and should be retained.

---

## 6.5 Graceful Degradation — Cold Start Handling

### 6.5.1 The Principle

The system is designed so that every component degrades gracefully under the absence of its primary inputs. The classification agent degrades from a language-model classifier to a keyword classifier when the model is unavailable. The routing agent's semantic-similarity feature degrades to zero when no skill embeddings have been computed. The asset-history feature degrades to zero when no rated history exists. The performance feature degrades to a neutral half when a provider has no track record. The explainer agent degrades to no-op when the model is unavailable, with assignments still committed and rationales merely absent. The learned ranker degrades to the deterministic baseline when the sidecar is unavailable or returns slowly.

These degradations are not exceptional behaviour invoked only during failures; they are the system's actual mode of operation during the substantial period before any of the learned components have meaningful data. The principle is that a component without data is in the same state as a component whose data source has failed, and the same fallback machinery handles both cases.

### 6.5.2 The Alternative Approach

A natural alternative — and the approach taken by many production machine-learning systems — is to require that the learned components have sufficient data before any component depending on them is enabled. Under this approach, the routing system would not be able to function at all until enough labelled outcomes had accumulated to train the ranker; it would block ticket assignment, or it would route tickets randomly during the data-collection phase, or it would defer to manual dispatch until the system was ready.

This approach has the appeal of simplicity: each component either has enough data to function or it does not, and the system's behaviour is bimodal between cold-start and warm operation. The cost is that the cold-start period — which may extend over many months — is a period of degraded operational utility. During this period, the system either does not function at all, or it functions in a special-case mode that is itself a separate codebase to maintain.

The graceful-degradation approach rejects this bimodality. The system's behaviour is not bimodal but continuous: at every moment, every component performs the best computation possible given the data available, with sensible defaults filling in for absent inputs. The cold-start period is not a special case but simply the period during which more components are operating with their default values. As data accumulates, more components transition from default to data-driven, and the system smoothly improves.

### 6.5.3 The Design of Default Values

Each default value in the system is chosen with deliberate care, because the defaults are themselves a form of design decision. The principle that informs the choices is sometimes called the principle of indifference: an absence of evidence should produce a neutral expectation, not a punitive or rewarding one.

The classification agent's keyword fallback returns a confidence value of `0.5`, a neutral half. The choice signals to downstream consumers that the classification is heuristic and should be treated as less reliable than a model-produced classification, without being so conservative that the heuristic is operationally useless. Downstream consumers can choose to weight the classification appropriately based on the confidence; the keyword classifier does not pretend to be confident in its result.

The semantic-similarity feature defaults to zero when no skill embedding exists for the candidate. This default is conservative: it says "no positive evidence of fit," not "negative evidence of misfit." A candidate with no skill embedding is treated identically by the routing formula to a candidate whose embedding produces a cosine similarity of exactly zero with the ticket. The deterministic features carry the routing decision in this case, and the candidate is selected or rejected on the basis of those features alone.

The asset-history feature similarly defaults to zero. The justification is the same: an absence of history is not negative evidence about the candidate's skill on this asset, merely absence of positive evidence.

The performance feature defaults to `0.5` for new providers, rather than zero. This is the one case where the default value is not zero, and the choice deserves explanation. A zero default for a new provider would systematically disadvantage them compared to existing providers with even modest track records, which would create a chilling effect on onboarding new providers (since their cold-start period would be one of suppressed assignments). The neutral-half default treats new providers as average until proven otherwise, allowing them to compete on the other features and accumulate the track record they need to displace the default.

These choices are individually small but collectively important: they encode the system's stance on how to handle absent information, and that stance must be both correct and consistent across components for the system as a whole to behave coherently.

### 6.5.4 The Operational Trajectory

The system's operational trajectory under graceful degradation is one of gradual improvement rather than threshold transitions. At day one, the classification agent runs on the language model (assuming an API key is configured), the deterministic features produce reasonable rankings, and the semantic and asset-history features contribute zero to every score. The routing decisions are based entirely on the deterministic features.

Over the first weeks, the moderator-verification flow accumulates `TicketRating` rows, which begin to populate the labelled-outcome data set. The skill-embedding refresh begins to compute embeddings for the technicians whose work has been verified. The semantic-similarity feature starts to contribute non-zero values for those technicians, with the contribution growing as more technicians accumulate verified resolutions. By the end of the first month, the system's routing decisions reflect both the deterministic baseline and the early learned signal.

Over the first quarter, the asset-history feature begins to contribute as enough tickets have been verified on enough assets to produce meaningful per-asset statistics. The routing decisions become further refined as both learned features carry meaningful signal.

By the end of the first year, the labelled-outcome dataset is large enough to support the first learned ranker. The deterministic baseline remains in place, but the learned ranker takes over as the primary scoring mechanism, with the deterministic baseline as the fallback path. The routing decisions are now produced by a model that has been trained on the full operational history of the system.

This trajectory is not a sequence of step transitions but a smooth evolution. There is no moment when the system's behaviour suddenly changes; instead, each refresh of an embedding, each new rating, and each successful resolution incrementally improves the routing decisions. The user-visible interface is unchanged throughout — store registers create tickets the same way on day one and on day three hundred — but the quality of the routing decisions improves continuously.

**Figure 6.3 — The graceful-degradation trajectory** *(to be rendered as a multi-line time-series chart)*. The figure should show four lines plotted against an x-axis representing time since system launch, with each line representing the contribution of one feature to the average routing score: skill match (constant, contributing from day one), proximity (constant, contributing from day one), semantic similarity (zero at launch, rising gradually as embeddings populate, leveling off after several months), and asset history (zero at launch, rising more slowly than semantic similarity due to its dependence on per-asset data, leveling off after a longer period). A vertical dashed line marks the point at which the learned ranker is enabled, after which all four features are subsumed into a single learned-score line that begins above the sum of the deterministic-feature contributions. The figure should make visually explicit that the system's quality grows continuously over time without sudden transitions.

### 6.5.5 The Alternative Trajectory and Why It Is Rejected

To make the graceful-degradation argument concrete, it is useful to describe the alternative trajectory that the threshold-based approach would produce. Under the threshold approach, the system would not enable the semantic-similarity feature until some minimum number of embeddings had been computed, would not enable the asset-history feature until some minimum number of ratings had accumulated, and would not enable the learned ranker until it had been trained and validated.

This trajectory has three undesirable properties. First, the activation thresholds are themselves design parameters that must be chosen, and the choices are essentially arbitrary (why one hundred embeddings, not fifty or two hundred?) with potentially large operational consequences. Second, the thresholds create discontinuities in the system's behaviour, where a single additional verification or embedding causes the routing scores to change qualitatively, which complicates analysis and debugging. Third, the threshold approach requires explicit coordination between data accumulation and component activation, which is a form of operational complexity that the graceful-degradation approach simply does not have.

The graceful-degradation approach has none of these properties. There are no thresholds, no qualitative discontinuities, and no operational coordination required. The system's behaviour is a continuous function of its accumulated data, and each component's contribution scales naturally with the data available to it.

### 6.5.6 What Graceful Degradation Does Not Provide

Graceful degradation does not eliminate the value of warm operation. A system whose learned features are all zero is operationally no better than a system without learned features at all, and the value of the learning architecture is realized only as data accumulates. The graceful-degradation principle does not promise that the cold-start system performs as well as the warm system; it promises only that the cold-start system performs as well as a system without the learning components, which is the appropriate baseline for evaluating its acceptability.

Specifically, the cold-start system's routing decisions are made on three deterministic features (skill match, proximity, availability) plus one with a neutral default (performance). These four features are operationally adequate for the routing task — they are, after all, the features that legacy dispatch systems rely on entirely — and the cold-start system's quality is therefore approximately that of a competent legacy system. The system's quality grows from this baseline as data accumulates, but the baseline itself is an acceptable starting point.

### 6.5.7 The Pattern Beyond This System

The graceful-degradation principle is not unique to this system, but its consistent application across every component is unusual enough to deserve naming. Most production systems handle the failure of their primary components by surfacing an error to the user; the system here handles the failure of its primary components by transparently substituting a degraded but operationally correct alternative. This requires that every component have a degraded alternative, that the alternative produce outputs in the same shape as the primary component, and that downstream consumers be designed to operate correctly on those outputs.

The discipline of designing each component this way is non-trivial. It requires that the component's output type be defined in a way that admits the degraded value — for instance, the routing agent's six-feature score must be well-defined when each individual feature is zero, which informed the choice of a convex combination over alternatives like a max-of-features formula that would behave differently under zero inputs. It requires that the degraded value not be confused with an error, so that downstream consumers do not incorrectly treat a zero feature as a special case requiring fallback. And it requires that the degradation be explicit in code, so that maintainers can understand why a particular default value was chosen and can update it if the underlying assumptions change.

The cumulative effect of applying this discipline across every component is a system that is robust to the failure of any individual component. The cost of the discipline is borne in design effort during construction, not in runtime cost during operation, and is therefore an investment that compounds favorably as the system grows.

### 6.5.8 When the Principle Might Be Revisited

The graceful-degradation principle is among the most defensible decisions in the system's design, and revisiting it would require a significant change in operational priorities. One scenario is worth identifying: a system where the failure of a learned component should produce a hard error rather than a silent degradation. This might apply in regulated domains where the outputs of a learned model are subject to audit, and a degraded output that resembles a model output but is actually a heuristic fallback might mislead a regulator about the system's behaviour. In such a domain, the principle would need to be revised to clearly distinguish learned from heuristic outputs, perhaps by marking each routing decision with the source of its score.

The current system is not subject to such regulation, and the graceful-degradation principle is the correct choice. It is, in fact, the principle that makes the rest of the architecture possible: every learned component in the system is structurally complete but operationally inert until data accumulates, and only the graceful-degradation principle allows the system to function correctly during the inertness without requiring a separate codebase for the cold-start period.

---

## Summary

This chapter has examined five design decisions in detail, each one a place where the obvious alternative would have been faster to build but worse to operate. The decision to keep the language model off the request path preserves user-facing latency, system availability under provider outages, and operational cost, at the price of giving up the flexibility and self-explainability of an LLM-driven design — losses that the system mitigates through deliberate compensating mechanisms. The decision to compute embeddings locally rather than via remote APIs preserves the privacy of ticket text, eliminates a class of operational dependencies, and lowers latency, at the price of a small quality gap and a thirty-megabyte model file. The decision to derive load from the assignment table rather than maintain a counter eliminates a class of silent-drift bugs by construction, at the price of one additional database query per ticket creation. The decision to share a single feature-builder module between training and serving paths prevents the pervasive bug class of train/serve skew by construction, at the price of constraining the offline data pipeline to use TypeScript for feature computation. The decision to design every component for graceful degradation makes the system operationally correct from day one regardless of data accumulation, at the price of design effort during construction.

These five decisions are not independent. The graceful-degradation principle informs the design of every individual component, including the feature builder's behaviour under absent inputs and the routing agent's behaviour under sidecar failures. The deterministic-routing decision is itself an instance of graceful degradation applied to the language-model dependency. The query-derived load and the single feature-builder both reflect the same underlying engineering attitude: prefer designs that are correct by construction over designs that require ongoing coordination, even when the latter are simpler in their immediate implementation. The local-embeddings decision is supported by the same operational considerations that motivate the deterministic-routing decision: third-party APIs are operational dependencies whose failures must be defended against, and replacing them with local alternatives where feasible eliminates the failure modes entirely.

The chapter is therefore not a list of independent choices but a presentation of an integrated design philosophy. The system favours correctness by construction over correctness by coordination, treats third-party dependencies as liabilities rather than assets, accepts modest costs in storage and computation in exchange for substantial improvements in operational reliability, and designs for the period during which learned components are inert with the same care as for the period during which they are warm. Each individual decision is defensible on its own; together they constitute the system's distinctive engineering character.

---

## Figures Summary

| # | Title | Type | Source |
|---|---|---|---|
| 6.1 | Latency budget comparison: deterministic vs LLM-driven routing | Stacked horizontal bar chart | descriptive callout |
| 6.2 | Counter-based vs derived-query load tracking | Two-panel architecture diagram | descriptive callout |
| 6.3 | The graceful-degradation trajectory over time | Multi-line time-series chart | descriptive callout |

All three figures in this chapter are descriptive callouts rather than inline Mermaid diagrams. The reason is that each figure communicates quantitative information (latency in milliseconds, query paths with annotations of failure modes, feature contributions over time) that requires precise visual representation more naturally produced in a dedicated diagramming or charting tool. The callouts in the chapter body describe each figure in sufficient detail for a designer to produce the final figures using draw.io, Figma, or a similar tool.

This chapter is the report's most argumentative, and the figures are intended to make the arguments concrete: Figure 6.1 quantifies the latency case against LLM-driven routing, Figure 6.2 makes the correctness gain from derived queries visually obvious, and Figure 6.3 illustrates that the system's quality is a continuous function of its accumulated data rather than a step function that activates at some threshold.
