-- O produto passa a se chamar Regents (spec #96). A 0012 chamou a Articuladora "Sophya (Shearim)"
-- quando já havia um Agente Sophya. Só esse nome exato muda: um nome que o Admin deu fica.
UPDATE "agents" SET "name" = 'Sophya (Regents)' WHERE "builtin" AND "name" = 'Sophya (Shearim)';
