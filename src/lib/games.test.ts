import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../../db/test-helpers';
import { categories, publishers, games } from '../../db/schema';
import type { Database } from './db';
import {
    getAllGames,
    getAllGameIds,
    getGameById,
    sortGames,
} from './games';
import type { Game } from '../types/game';

interface GameFixture {
    title: string;
    starRating: number | null;
}

async function seedGames(db: Database, count: number): Promise<void> {
    const fixtures: GameFixture[] = Array.from({ length: count }, (_, index) => {
        const gameNumber = count - index;
        return {
            title: `Game ${String(gameNumber).padStart(2, '0')}`,
            starRating: 4.2,
        };
    });

    await seedGameFixtures(db, fixtures);
}

async function seedGameFixtures(db: Database, fixtures: GameFixture[]): Promise<void> {
    const [category] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'cat' })
        .returning({ id: categories.id });
    const [publisher] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'pub' })
        .returning({ id: publishers.id });

    for (const fixture of fixtures) {
        await db.insert(games).values({
            title: fixture.title,
            description: `Description for ${fixture.title}`,
            starRating: fixture.starRating,
            categoryId: category.id,
            publisherId: publisher.id,
        });
    }
}

function createGame(overrides: Partial<Game>): Game {
    return {
        id: overrides.id ?? 1,
        title: overrides.title ?? 'Game',
        description: overrides.description ?? 'Description',
        starRating: overrides.starRating !== undefined ? overrides.starRating : 4,
        category: overrides.category ?? null,
        publisher: overrides.publisher ?? null,
    };
}

describe('games data-access helpers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns all games ordered by title', async () => {
        await seedGames(db, 3);
        const all = await getAllGames(db);
        expect(all.map((g) => g.title)).toEqual(['Game 01', 'Game 02', 'Game 03']);
        expect(all[0].category).toEqual({ id: expect.any(Number), name: 'Strategy' });
        expect(all[0].publisher).toEqual({ id: expect.any(Number), name: 'Pub One' });
    });

    it('returns all games ordered by title descending when requested', async () => {
        await seedGames(db, 3);
        const all = await getAllGames(db, 'title-desc');
        expect(all.map((g) => g.title)).toEqual(['Game 03', 'Game 02', 'Game 01']);
    });

    it('returns all games ordered by rating with unrated games last', async () => {
        await seedGameFixtures(db, [
            { title: 'Unrated Alpha', starRating: null },
            { title: 'Mid Game', starRating: 4.1 },
            { title: 'Top Game', starRating: 4.9 },
            { title: 'Unrated Beta', starRating: null },
        ]);

        const all = await getAllGames(db, 'rating-desc');

        expect(all.map((g) => g.title)).toEqual([
            'Top Game',
            'Mid Game',
            'Unrated Alpha',
            'Unrated Beta',
        ]);
    });

    it('returns all game ids ordered by title', async () => {
        await seedGames(db, 3);
        const ids = await getAllGameIds(db);
        const all = await getAllGames(db);
        expect(ids).toEqual(all.map((g) => g.id));
    });

    it('fetches a single game by id', async () => {
        await seedGames(db, 2);
        const ids = await getAllGameIds(db);
        const game = await getGameById(db, ids[0]);
        expect(game?.title).toBe('Game 01');
    });

    it('returns null for a non-existent game', async () => {
        await seedGames(db, 2);
        expect(await getGameById(db, 99999)).toBeNull();
    });
});

describe('sortGames', () => {
    const unsortedGames: Game[] = [
        createGame({ id: 1, title: 'Beta', starRating: 4.8 }),
        createGame({ id: 2, title: 'Alpha', starRating: null }),
        createGame({ id: 3, title: 'Delta', starRating: 4.8 }),
        createGame({ id: 4, title: 'Gamma', starRating: 3.9 }),
    ];

    it('sorts games by title ascending by default', () => {
        const sorted = sortGames(unsortedGames);
        expect(sorted.map((game) => game.title)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
    });

    it('sorts games by title descending', () => {
        const sorted = sortGames(unsortedGames, 'title-desc');
        expect(sorted.map((game) => game.title)).toEqual(['Gamma', 'Delta', 'Beta', 'Alpha']);
    });

    it('sorts rated games by rating descending with title tie-breakers and unrated games last', () => {
        const sorted = sortGames(unsortedGames, 'rating-desc');
        expect(sorted.map((game) => game.title)).toEqual(['Beta', 'Delta', 'Gamma', 'Alpha']);
    });

    it('does not mutate the provided games array', () => {
        const originalOrder = unsortedGames.map((game) => game.title);
        sortGames(unsortedGames, 'title-desc');
        expect(unsortedGames.map((game) => game.title)).toEqual(originalOrder);
    });
});
