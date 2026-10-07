# CRS equipment borrowing

This context manages custody of individual equipment and the people authorized to request or administer it.

## Language

**Equipment**:
One physical asset with its own identity and custody state; identical items may share an SKU.
_Avoid_: Stock quantity, equipment batch

**User**:
One administrator-authorized person, regardless of supported sign-in method.
_Avoid_: Google user versus password user, automatically registered account

**Borrow request**:
A user's request to borrow specified equipment, not evidence of issue.
_Avoid_: Checkout, completed loan

**Checkout**:
The administrator-confirmed issue of approved equipment into the borrower's custody.
_Avoid_: Approval

**Inspected return**:
An administrator's confirmation of returned equipment, condition and required accessories.
_Avoid_: Return request

**Public equipment projection**:
Intentionally limited catalog information approved for guests; publication grants no custody or internal-data access.
_Avoid_: Public database, public image folder

**Borrow intent**:
A visitor's equipment choice to revisit after sign-in, not a submitted or authorized request.
_Avoid_: Reservation, automatic borrowing

**Temporary password**:
A time-limited credential requiring replacement before ordinary system use.
_Avoid_: Permanent generated password

**Security confirmation**:
An emailed single-use confirmation authorizing a particular password change or reset.
_Avoid_: Phishing-resistant MFA, Google handoff code

**Notification**:
A recipient-specific notice of a committed custody-workflow event.
_Avoid_: Browser-generated approval, transaction authority
