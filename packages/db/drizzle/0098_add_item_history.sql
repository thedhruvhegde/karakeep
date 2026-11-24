CREATE TABLE `itemHistory` (
	`id` text PRIMARY KEY NOT NULL,
	`itemType` text NOT NULL,
	`itemId` text NOT NULL,
	`ownerId` text NOT NULL,
	`changeId` text NOT NULL,
	`fieldName` text NOT NULL,
	`oldValue` text NOT NULL,
	`newValue` text NOT NULL,
	`changedBy` text,
	`source` text DEFAULT 'user' NOT NULL,
	`changedAt` integer NOT NULL,
	FOREIGN KEY (`ownerId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`changedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `itemHistory_item_changedAt_idx` ON `itemHistory` (`itemType`,`itemId`,`changedAt`,`id`);--> statement-breakpoint
CREATE INDEX `itemHistory_ownerId_idx` ON `itemHistory` (`ownerId`);--> statement-breakpoint
CREATE INDEX `itemHistory_changedBy_idx` ON `itemHistory` (`changedBy`);