# Cold

Cold is a cold email deliverability platform. It enforces a 14-rule deliverability playbook as guardrails in the software:

- It protects the primary domain.
- It provisions lookalike sending domains on Google Workspace or Microsoft 365.
- It authenticates and warms every inbox, and enforces per-domain volume caps.
- It cleans lists, lints copy, and staggers sends.
- It measures domain health against baselines and diagnoses whether copy or infrastructure is at fault.
- It rotates in warmed replacements without stopping sending or losing a reply.

**Status:** specification stage. Start with [`SPEC.md`](SPEC.md).

| Read this | For |
|---|---|
| [§5 System invariants](SPEC.md#5-system-invariants) | The 10 guarantees the send pipeline never breaks |
| [§6 Functional requirements](SPEC.md#6-functional-requirements) | Requirements by module, each tagged to its playbook rule |
| [§8 Key algorithms](SPEC.md#8-key-algorithms) | Capacity planner, scheduler, health evaluation, rotation |
| [§14 Policy reference](SPEC.md#14-policy-configuration-reference) | Every default, where it comes from, and whether it can be overridden |
| [§17 Open questions](SPEC.md#17-open-questions) | Decisions needed before build |
| [Appendix A](SPEC.md#appendix-a--playbook-traceability-matrix) | Playbook rule → requirement traceability |
