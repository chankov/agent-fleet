# Grilling (Internal Helper)

Use this helper from a parent skill when the user asks to grill or stress-test a plan, spec, or design, or when an important design choice is being silently assumed.

Interview the user relentlessly until the important decisions are explicitly accepted, rejected, or deferred. Walk the design tree one dependency at a time: choose the next question based on prior answers, and skip questions made irrelevant by earlier decisions.

Ask one focused question at a time. Offer 2-4 concrete options plus your recommended answer and a brief reason, then wait for the user's decision before continuing. This should feel like guided architectural interrogation, not a questionnaire dump.

If a question can be answered by reading the codebase, docs, tests, or runtime evidence, investigate first and ask only about the remaining decision.

Keep grilling until shared understanding is strong enough to write or revise the downstream artifact. When review exposes gaps later, convert each gap into one targeted follow-up question.
