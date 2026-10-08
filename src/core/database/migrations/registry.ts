import type { Migration } from './types';
import { migration001 } from './migration001';
import { migration002 } from './migration002';
import { migration003 } from './migration003';
import { migration004 } from './migration004';
import { migration005 } from './migration005';
import { migration006 } from './migration006';
import { migration007 } from './migration007';
import { migration008 } from './migration008';
import { migration009 } from './migration009';
import { migration010 } from './migration010';
import { migration011 } from './migration011';
import { migration012 } from './migration012';
import { migration013 } from './migration013';
import { migration014 } from './migration014';
import { migration015 } from './migration015';
import { migration016 } from './migration016';
import { migration017 } from './migration017';
import { migration018 } from './migration018';
import { migration019 } from './migration019';
import { migration020 } from './migration020';
import { migration021 } from './migration021';
import { migration022 } from './migration022';
import { migration023 } from './migration023';
import { migration024 } from './migration024';
import { migration025 } from './migration025';
import { migration026 } from './migration026';

const REGISTERED_MIGRATIONS: readonly Migration[] = Object.freeze([
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
  migration026,
]);

const expectedVersions = REGISTERED_MIGRATIONS.map((migration, index) => index + 1);
const actualVersions = REGISTERED_MIGRATIONS.map((migration) => migration.version);
if (actualVersions.some((version, index) => version !== expectedVersions[index])) {
  throw new Error('[MIGRATION_REGISTRY_INVALID] Expected contiguous migration versions 1..' + REGISTERED_MIGRATIONS.length + '; got ' + actualVersions.join(','));
}
if (new Set(REGISTERED_MIGRATIONS.map((migration) => migration.name)).size !== REGISTERED_MIGRATIONS.length) {
  throw new Error('[MIGRATION_REGISTRY_INVALID] Migration names must be unique');
}

export const MIGRATIONS: readonly Migration[] = REGISTERED_MIGRATIONS;
