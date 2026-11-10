# Implementation tickets

The approved implementation breakdown is published in [GitHub Issues](https://github.com/drblue/timekeeper/issues). GitHub is authoritative for live status and blocking relationships; the table below is the publication index, not a second status tracker.

All tickets carry `ready-for-agent`; work starts only when blockers are complete and the coordinator selects it. PostgreSQL and MariaDB transfers are optional, very low priority, and do not block the initial SQLite release. Preserve portability and early provider checks even if those transfer tickets are never implemented.

| Ticket | Outcome | Initial blockers |
| --- | --- | --- |
| [#1](https://github.com/drblue/timekeeper/issues/1) | Run the application end to end | None |
| [#2](https://github.com/drblue/timekeeper/issues/2) | Verify persistence on all three database engines | [#1](https://github.com/drblue/timekeeper/issues/1) |
| [#3](https://github.com/drblue/timekeeper/issues/3) | Evaluate PDF layout and resource use | [#1](https://github.com/drblue/timekeeper/issues/1) |
| [#4](https://github.com/drblue/timekeeper/issues/4) | Provision an account and sign in securely | [#2](https://github.com/drblue/timekeeper/issues/2) |
| [#5](https://github.com/drblue/timekeeper/issues/5) | Manage clients and projects | [#4](https://github.com/drblue/timekeeper/issues/4) |
| [#6](https://github.com/drblue/timekeeper/issues/6) | Record duration-only work | [#5](https://github.com/drblue/timekeeper/issues/5) |
| [#7](https://github.com/drblue/timekeeper/issues/7) | Record timed work across calendar boundaries | [#6](https://github.com/drblue/timekeeper/issues/6) |
| [#8](https://github.com/drblue/timekeeper/issues/8) | Start and stop a durable timer | [#7](https://github.com/drblue/timekeeper/issues/7) |
| [#9](https://github.com/drblue/timekeeper/issues/9) | Switch activities and continue previous work | [#8](https://github.com/drblue/timekeeper/issues/8) |
| [#10](https://github.com/drblue/timekeeper/issues/10) | Correct entries and inspect their history | [#7](https://github.com/drblue/timekeeper/issues/7) |
| [#11](https://github.com/drblue/timekeeper/issues/11) | Filter and navigate the work list | [#8](https://github.com/drblue/timekeeper/issues/8), [#10](https://github.com/drblue/timekeeper/issues/10) |
| [#12](https://github.com/drblue/timekeeper/issues/12) | Delete and restore entries | [#10](https://github.com/drblue/timekeeper/issues/10) |
| [#13](https://github.com/drblue/timekeeper/issues/13) | Track external invoice details | [#10](https://github.com/drblue/timekeeper/issues/10) |
| [#14](https://github.com/drblue/timekeeper/issues/14) | Preview and apply bulk actions | [#11](https://github.com/drblue/timekeeper/issues/11), [#12](https://github.com/drblue/timekeeper/issues/12), [#13](https://github.com/drblue/timekeeper/issues/13) |
| [#15](https://github.com/drblue/timekeeper/issues/15) | Split boundary-crossing work before invoicing | [#14](https://github.com/drblue/timekeeper/issues/14) |
| [#16](https://github.com/drblue/timekeeper/issues/16) | Preview a filtered time report | [#11](https://github.com/drblue/timekeeper/issues/11) |
| [#17](https://github.com/drblue/timekeeper/issues/17) | Configure report presentation | [#16](https://github.com/drblue/timekeeper/issues/16) |
| [#18](https://github.com/drblue/timekeeper/issues/18) | Generate and download production PDFs | [#3](https://github.com/drblue/timekeeper/issues/3), [#17](https://github.com/drblue/timekeeper/issues/17) |
| [#19](https://github.com/drblue/timekeeper/issues/19) | Upload and inspect a Clockify export | [#7](https://github.com/drblue/timekeeper/issues/7) |
| [#20](https://github.com/drblue/timekeeper/issues/20) | Import mapped Clockify entries without repeat duplicates | [#15](https://github.com/drblue/timekeeper/issues/15), [#19](https://github.com/drblue/timekeeper/issues/19) |
| [#21](https://github.com/drblue/timekeeper/issues/21) | Handle identical Clockify rows explicitly | [#20](https://github.com/drblue/timekeeper/issues/20) |
| [#22](https://github.com/drblue/timekeeper/issues/22) | Resolve corrected Clockify records | [#21](https://github.com/drblue/timekeeper/issues/21) |
| [#23](https://github.com/drblue/timekeeper/issues/23) | Undo an eligible import safely | [#22](https://github.com/drblue/timekeeper/issues/22) |
| [#24](https://github.com/drblue/timekeeper/issues/24) | Export complete data and filtered CSV | [#17](https://github.com/drblue/timekeeper/issues/17), [#23](https://github.com/drblue/timekeeper/issues/23) |
| [#25](https://github.com/drblue/timekeeper/issues/25) | Install and use the app on a phone | [#9](https://github.com/drblue/timekeeper/issues/9), [#11](https://github.com/drblue/timekeeper/issues/11) |
| [#26](https://github.com/drblue/timekeeper/issues/26) | Deploy and upgrade on Pi and VPS | [#4](https://github.com/drblue/timekeeper/issues/4) |
| [#27](https://github.com/drblue/timekeeper/issues/27) | Back up and restore a populated instance | [#17](https://github.com/drblue/timekeeper/issues/17), [#23](https://github.com/drblue/timekeeper/issues/23), [#26](https://github.com/drblue/timekeeper/issues/26) |
| [#28](https://github.com/drblue/timekeeper/issues/28) | [Very low priority] Transfer SQLite data to PostgreSQL | [#24](https://github.com/drblue/timekeeper/issues/24), [#27](https://github.com/drblue/timekeeper/issues/27) |
| [#29](https://github.com/drblue/timekeeper/issues/29) | [Very low priority] Transfer SQLite data to MariaDB | [#24](https://github.com/drblue/timekeeper/issues/24), [#27](https://github.com/drblue/timekeeper/issues/27) |
| [#30](https://github.com/drblue/timekeeper/issues/30) | Rehearse the complete initial release | [#18](https://github.com/drblue/timekeeper/issues/18), [#24](https://github.com/drblue/timekeeper/issues/24), [#25](https://github.com/drblue/timekeeper/issues/25), [#27](https://github.com/drblue/timekeeper/issues/27) |

The first startable ticket is #1. Coordinate focused implementation, independent validation and different-model review according to [the agent workflow](agents/implementation.md).
