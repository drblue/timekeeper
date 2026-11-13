export function validLocalDate(localDate: string): boolean {
	if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(localDate)) return false;
	const year = Number(localDate.slice(0, 4));
	const month = Number(localDate.slice(5, 7));
	const day = Number(localDate.slice(8, 10));
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return year > 0 && day > 0 && day <= (monthDays[month - 1] ?? 0);
}
