# Timekeeper

Timekeeper records work and its billable value, and produces time reports.

## Language

**Client**:
A person or organization for whom work is performed. A client may have a default hourly rate.

**Project**:
A grouping of work that may belong to one client. Its default hourly rate inherits from that client unless overridden.

**Time entry**:
A record of work and its duration, captured using a timer or entered manually. It may belong to a project, directly to a client, or neither; an entry's project determines its client when present.
_Avoid_: Activity record, timesheet row

**Running timer**:
The active measurement of time spent on work. Only one timer may run at a time.

**Effective hourly rate**:
The hourly rate assigned to a time entry after applying defaults or an explicit override. Existing entries retain their assigned rate when defaults change.

**Billable amount**:
The amount chargeable for work, calculated from its duration and effective hourly rate.
_Avoid_: Cost

**Non-billable work**:
Work tracked intentionally without a charge, distinct from billable work awaiting invoicing.

**Invoiced entry**:
A time entry marked as included on an invoice created outside Timekeeper. It may carry an invoice reference.

**Time report**:
A presentation of recorded work over a selected date range, optionally restricted by client or project. It is distinct from an invoice.

**Timed entry**:
A time entry with known start and end times, whether captured by a timer or entered manually.

**Duration-only entry**:
A time entry assigned to a date and duration without start or end times.

**Archived client or project**:
A client or project retained for historical work and reporting but hidden from normal choices for new work.
