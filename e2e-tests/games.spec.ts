import { test, expect, type Page, type Response } from '@playwright/test';

interface GameSummary {
  title: string;
  rating: number | null;
}

async function getGameSummaries(page: Page): Promise<GameSummary[]> {
  return page.getByTestId('game-card').evaluateAll((cards) =>
    cards.map((card) => {
      const element = card as HTMLElement;
      const rawRating = element.dataset.gameRating;
      const rating = rawRating ? Number(rawRating) : null;

      return {
        title: element.dataset.gameTitle ?? '',
        rating: rating !== null && Number.isFinite(rating) ? rating : null,
      };
    }),
  );
}

function getTitles(games: GameSummary[]): string[] {
  return games.map((game) => game.title);
}

function compareTitleAsc(a: GameSummary, b: GameSummary): number {
  return a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
}

function compareRatingDesc(a: GameSummary, b: GameSummary): number {
  if (a.rating === null && b.rating === null) {
    return compareTitleAsc(a, b);
  }

  if (a.rating === null) {
    return 1;
  }

  if (b.rating === null) {
    return -1;
  }

  const ratingOrder = b.rating - a.rating;
  return ratingOrder === 0 ? compareTitleAsc(a, b) : ratingOrder;
}

test.describe('Game Listing and Navigation', () => {
  test('should display games with titles on index page', async ({ page }) => {
    await test.step('Navigate to homepage', async () => {
      await page.goto('/');
    });

    await test.step('Verify games grid is visible', async () => {
      const gamesGrid = page.getByTestId('games-grid');
      await expect(gamesGrid).toBeVisible();
    });

    await test.step('Verify game cards are displayed', async () => {
      const gameCards = page.getByTestId('game-card');
      await expect(gameCards.first()).toBeVisible();
      expect(await gameCards.count()).toBeGreaterThan(0);
    });

    await test.step('Verify game cards have titles with content', async () => {
      const gameCards = page.getByTestId('game-card');
      await expect(gameCards.first().getByTestId('game-title')).toBeVisible();
      await expect(gameCards.first().getByTestId('game-title')).not.toBeEmpty();
    });
  });

  test('should navigate to correct game details page when clicking on a game', async ({ page }) => {
    let gameId: string | null;
    let gameTitle: string | null;

    await test.step('Navigate to homepage and wait for games to load', async () => {
      await page.goto('/');
      const gamesGrid = page.getByTestId('games-grid');
      await expect(gamesGrid).toBeVisible();
    });

    await test.step('Get first game information and click it', async () => {
      const firstGameCard = page.getByTestId('game-card').first();
      gameId = await firstGameCard.getAttribute('data-game-id');
      gameTitle = await firstGameCard.getAttribute('data-game-title');
      await firstGameCard.click();
    });

    await test.step('Verify navigation to game details page', async () => {
      await expect(page).toHaveURL(`/game/${gameId}`);
      await expect(page.getByTestId('game-details')).toBeVisible();
    });

    await test.step('Verify game title matches clicked game', async () => {
      if (gameTitle) {
        await expect(page.getByTestId('game-details-title')).toHaveText(gameTitle);
      }
    });
  });

  test('should sort games by title using the sort control', async ({ page }) => {
    await test.step('Navigate to homepage', async () => {
      await page.goto('/');
      await expect(page.getByTestId('games-grid')).toBeVisible();
    });

    await test.step('Verify default title ascending order', async () => {
      const sortSelect = page.getByRole('combobox', { name: /sort games/i });
      await expect(sortSelect).toHaveValue('title-asc');

      const games = await getGameSummaries(page);
      const expectedTitles = getTitles([...games].sort(compareTitleAsc));
      expect(getTitles(games)).toEqual(expectedTitles);
    });

    await test.step('Sort by title descending', async () => {
      const sortSelect = page.getByRole('combobox', { name: /sort games/i });
      await sortSelect.selectOption('title-desc');
      await expect(sortSelect).toHaveValue('title-desc');

      const games = await getGameSummaries(page);
      const expectedTitles = getTitles([...games].sort((a, b) => compareTitleAsc(b, a)));
      expect(getTitles(games)).toEqual(expectedTitles);
    });
  });

  test('should sort games by highest star rating using the sort control', async ({ page }) => {
    await test.step('Navigate to homepage', async () => {
      await page.goto('/');
      await expect(page.getByTestId('games-grid')).toBeVisible();
    });

    await test.step('Sort by highest star rating', async () => {
      const sortSelect = page.getByRole('combobox', { name: /sort games/i });
      await sortSelect.selectOption('rating-desc');
      await expect(sortSelect).toHaveValue('rating-desc');

      const games = await getGameSummaries(page);
      const expectedTitles = getTitles([...games].sort(compareRatingDesc));
      expect(getTitles(games)).toEqual(expectedTitles);
    });
  });

  test('should display game details with all required information', async ({ page }) => {
    await test.step('Navigate to specific game details page', async () => {
      await page.goto('/game/1');
      await expect(page.getByTestId('game-details')).toBeVisible();
    });

    await test.step('Verify game title is displayed', async () => {
      const gameTitle = page.getByTestId('game-details-title');
      await expect(gameTitle).toBeVisible();
      await expect(gameTitle).not.toBeEmpty();
    });

    await test.step('Verify game description is displayed', async () => {
      const gameDescription = page.getByTestId('game-details-description');
      await expect(gameDescription).toBeVisible();
      await expect(gameDescription).not.toBeEmpty();
    });

    await test.step('Verify publisher or category information is present', async () => {
      const publisherExists = await page.getByTestId('game-details-publisher').isVisible();
      const categoryExists = await page.getByTestId('game-details-category').isVisible();
      expect(publisherExists || categoryExists).toBeTruthy();

      if (publisherExists) {
        await expect(page.getByTestId('game-details-publisher')).not.toBeEmpty();
      }

      if (categoryExists) {
        await expect(page.getByTestId('game-details-category')).not.toBeEmpty();
      }
    });
  });

  test('should display a button to back the game', async ({ page }) => {
    await test.step('Navigate to game details page', async () => {
      await page.goto('/game/1');
      await expect(page.getByTestId('game-details')).toBeVisible();
    });

    await test.step('Verify back game button is visible and enabled', async () => {
      const backButton = page.getByTestId('back-game-button');
      await expect(backButton).toBeVisible();
      await expect(backButton).toContainText('Support This Game');
      await expect(backButton).toBeEnabled();
    });
  });

  test('should be able to navigate back to home from game details', async ({ page }) => {
    await test.step('Navigate to game details page', async () => {
      await page.goto('/game/1');
      await expect(page.getByTestId('game-details')).toBeVisible();
    });

    await test.step('Click back to all games link', async () => {
      const backLink = page.getByRole('link', { name: /back to all games/i });
      await expect(backLink).toBeVisible();
      await backLink.click();
    });

    await test.step('Verify navigation back to homepage', async () => {
      await expect(page).toHaveURL('/');
      await expect(page.getByTestId('games-grid')).toBeVisible();
    });
  });

  test('should return a 404 page for a non-existent game', async ({ page }) => {
    let response: Response | null;

    await test.step('Navigate to non-existent game', async () => {
      response = await page.goto('/game/99999');
    });

    await test.step('Verify a branded 404 page is served', async () => {
      expect(response?.status()).toBe(404);
      await expect(page).toHaveTitle(/Page Not Found - Tailspin Toys/);
      await expect(page.getByTestId('not-found')).toBeVisible();
      await expect(page.getByTestId('not-found-heading')).not.toBeEmpty();
      await expect(page.getByTestId('not-found-home-link')).toBeVisible();
    });
  });
});
