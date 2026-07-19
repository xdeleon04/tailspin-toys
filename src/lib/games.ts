import { eq, asc } from 'drizzle-orm';
import type { Database } from './db';
import { games, categories, publishers } from '../../db/schema';
import type { Game } from '../types/game';

export type GameSortOption = 'title-asc' | 'title-desc' | 'rating-desc';

export interface GameSortChoice {
    value: GameSortOption;
    label: string;
}

export const defaultGameSortOption: GameSortOption = 'title-asc';

export const gameSortChoices: GameSortChoice[] = [
    { value: 'title-asc', label: 'Title (A-Z)' },
    { value: 'title-desc', label: 'Title (Z-A)' },
    { value: 'rating-desc', label: 'Star rating (highest first)' },
];

const gameSelection = {
    id: games.id,
    title: games.title,
    description: games.description,
    starRating: games.starRating,
    categoryId: categories.id,
    categoryName: categories.name,
    publisherId: publishers.id,
    publisherName: publishers.name,
};

interface GameSelectionRow {
    id: number;
    title: string;
    description: string;
    starRating: number | null;
    categoryId: number | null;
    categoryName: string | null;
    publisherId: number | null;
    publisherName: string | null;
}

function mapGame(row: GameSelectionRow): Game {
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        starRating: row.starRating,
        category:
            row.categoryId !== null && row.categoryName !== null
                ? { id: row.categoryId, name: row.categoryName }
                : null,
        publisher:
            row.publisherId !== null && row.publisherName !== null
                ? { id: row.publisherId, name: row.publisherName }
                : null,
    };
}

function baseGamesQuery(db: Database) {
    return db
        .select(gameSelection)
        .from(games)
        .leftJoin(categories, eq(games.categoryId, categories.id))
        .leftJoin(publishers, eq(games.publisherId, publishers.id));
}

function compareByTitleAsc(a: Game, b: Game): number {
    return a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
}

function compareByTitleDesc(a: Game, b: Game): number {
    return compareByTitleAsc(b, a);
}

function compareByRatingDesc(a: Game, b: Game): number {
    if (a.starRating === null && b.starRating === null) {
        return compareByTitleAsc(a, b);
    }

    if (a.starRating === null) {
        return 1;
    }

    if (b.starRating === null) {
        return -1;
    }

    const ratingOrder = b.starRating - a.starRating;
    return ratingOrder === 0 ? compareByTitleAsc(a, b) : ratingOrder;
}

/**
 * Returns a copy of the provided games in the requested catalog order.
 *
 * @param gamesToSort - Games returned by the build-time database client or supplied by tests.
 * @param sortOption - Supported game list order. Rating sort places unrated games after rated games.
 * @returns A new array sorted deterministically for the homepage catalog.
 */
export function sortGames(gamesToSort: readonly Game[], sortOption: GameSortOption = defaultGameSortOption): Game[] {
    const sortedGames = [...gamesToSort];

    switch (sortOption) {
        case 'title-desc':
            return sortedGames.sort(compareByTitleDesc);
        case 'rating-desc':
            return sortedGames.sort(compareByRatingDesc);
        case 'title-asc':
            return sortedGames.sort(compareByTitleAsc);
    }
}

/**
 * Returns all games in a deterministic catalog order for static homepage rendering.
 *
 * @param db - Drizzle database client; pages pass the build-time client and tests pass an in-memory client.
 * @param sortOption - Supported game list order. Defaults to title A-Z to preserve the original homepage order.
 * @returns Games with category and publisher summaries sorted by the requested option.
 */
export async function getAllGames(db: Database, sortOption: GameSortOption = defaultGameSortOption): Promise<Game[]> {
    const rows = await baseGamesQuery(db).orderBy(asc(games.title));
    return sortGames(rows.map(mapGame), sortOption);
}

/**
 * Returns all game IDs in deterministic title order for static route generation.
 *
 * @param db - Drizzle database client; pages pass the build-time client and tests pass an in-memory client.
 * @returns Ordered game IDs for `getStaticPaths()`.
 */
export async function getAllGameIds(db: Database): Promise<number[]> {
    const rows = await db.select({ id: games.id }).from(games).orderBy(asc(games.title));
    return rows.map((row) => row.id);
}

/**
 * Returns one game by ID for a prerendered details page.
 *
 * @param db - Drizzle database client; pages pass the build-time client and tests pass an in-memory client.
 * @param id - Game ID from the route parameter or test fixture.
 * @returns The matching game with category and publisher summaries, or `null` when no game exists.
 */
export async function getGameById(db: Database, id: number): Promise<Game | null> {
    const rows = await baseGamesQuery(db).where(eq(games.id, id)).limit(1);
    return rows.length > 0 ? mapGame(rows[0]) : null;
}
