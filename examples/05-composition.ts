/**
 * 05 — named conditions and composition (all / any / not).
 *
 * A named condition carries a name and a message that surface in violation
 * errors. Composites (`all`, `any`, `not`) build bigger conditions out of
 * smaller ones; the composite itself gets a readable name built from its
 * children, e.g. `all(not blank, email shape)`.
 *
 * Run: bun run examples/05-composition.ts
 */
import { all, any, condition, contract, not, PreconditionViolationError } from '../src/index.js';

// Leaf conditions — the atoms of the validation rule.
const notBlank = condition((s: string) => s.trim().length > 0, {
    name: 'not blank',
    message: 'value must not be blank',
});
const emailShape = condition((s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(s), {
    name: 'email shape',
    message: 'value must look like an email address',
});
const disposable = condition((s: string) => /@(mailinator|tempmail|10minutemail)\./.test(s), {
    name: 'disposable domain',
    message: 'disposable email domains are not allowed',
});
const workAddress = condition((s: string) => s.endsWith('@example.com'), {
    name: 'work address',
    message: 'must be an @example.com address',
});
const eduAddress = condition((s: string) => s.endsWith('.edu'), {
    name: 'edu address',
    message: 'must be a .edu address',
});

// Composites — flat, so the generated name reads well in errors.
const trustedEmail = all(notBlank, emailShape, not(disposable));
const inviteEmail = any(workAddress, eduAddress);

const subscribe = contract(
    function subscribe(email: string): string {
        return `subscribed ${email}`;
    },
    { name: 'subscribe', pre: [trustedEmail] },
);

const invite = contract(
    function invite(email: string): string {
        return `invited ${email}`;
    },
    { name: 'invite', pre: [inviteEmail] },
);

console.log(subscribe('ada@example.com'));
console.log(invite('prof.hopper@cs.edu'));

for (const email of ['', 'ada@mailinator.com']) {
    try {
        subscribe(email);
        console.log('unreachable: no error thrown');
    } catch (error) {
        if (error instanceof PreconditionViolationError) {
            console.log(`subscribe(${JSON.stringify(email)}) -> ${error.message}`);
        } else {
            throw error;
        }
    }
}

try {
    invite('random@gmail.com');
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log(`invite(random@gmail.com) -> ${error.message}`);
    } else {
        throw error;
    }
}

// Direct evaluation: after a false check, `lastFailure` explains exactly
// which part failed — synchronously valid, nothing to await.
console.log('trustedEmail.check("nope") =', trustedEmail.check('nope'));
console.log('lastFailure:', JSON.stringify(trustedEmail.lastFailure, null, 2));
