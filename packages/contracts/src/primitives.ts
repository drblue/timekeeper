import { Type } from '@sinclair/typebox';

export const Uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
export const NullableUuid = Type.Union([Uuid, Type.Null()]);
export const maxStoredInt = 2_147_483_647;
export const Revision = Type.Integer({ minimum: 1, maximum: maxStoredInt });

const integerOrePattern = '^(0|[1-9][0-9]{0,18})$';
export const Ore = Type.String({ pattern: integerOrePattern, description: 'Integer öre as a decimal string.' });
export const NullableHourlyRate = Type.Union([
	Type.String({ pattern: integerOrePattern, description: 'Integer öre per hour as a decimal string.' }),
	Type.Null(),
]);
