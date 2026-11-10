import { argon2id, hash, verify } from 'argon2';
import { maxPasswordLength, minPasswordLength } from '@timekeeper/contracts';

export const passwordLengthMessage =
	`Use ${minPasswordLength} to ${maxPasswordLength} characters on one line.`;

export function validNewPassword(password: string): boolean {
	const length = Array.from(password).length;
	return length >= minPasswordLength && length <= maxPasswordLength && !/[\r\n\0]/.test(password);
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function validEmail(email: string): boolean {
	return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
}

export function hashPassword(password: string) {
	return hash(password, { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export function verifyPassword(passwordHash: string, password: string) {
	return verify(passwordHash, password);
}
