/**
 * Managed-pool identity primitives for the Catalog Person Pool feature.
 *
 * A "managed person" is one of exactly three people created per active SlaveTemplate
 * (poolSlot 1, 2, 3). This module supplies the English-name generator/validator that
 * later control code uses when creating those people. Names are NOT persisted here --
 * the control layer owns database uniqueness and retry logic.
 *
 * Randomness is injectable so unit tests are deterministic; production callers pass
 * no argument and get cryptographic randomness via the default.
 */

/**
 * English first-name vocabulary. Bounded so callers can reason about capacity.
 *
 * Final review, Important 6: this list and {@link LAST_NAMES} used to hold 65 and 59 entries --
 * 3,835 combinations. `Person.name` is unique across the WHOLE installation (M58 R14) and the
 * pool needs three names per ACTIVE template, which on the installation this was measured against
 * is 834 names out of those 3,835. At that density a collision is not bad luck, it is the
 * expected case, and `syncPersonPool`'s bounded retry can exhaust on a perfectly healthy
 * catalogue -- an error an operator would read as a bug. The two dictionaries now offer
 * 493 x 1474 = 726,682 combinations, so the pool
 * is bounded by intent rather than by arithmetic.
 *
 * Curated English given names, one word each, sorted. Sorted is not cosmetic: it is what makes a
 * duplicate visible to whoever edits the list next, and `pool.test.ts` pins both properties.
 */
export const FIRST_NAMES: readonly string[] = [
  'Abigail', 'Ada', 'Adam', 'Adelaide', 'Adrian', 'Agatha',
  'Agnes', 'Aidan', 'Alan', 'Alastair', 'Albert', 'Alec',
  'Alexander', 'Alexandra', 'Alfred', 'Alice', 'Alison', 'Allan',
  'Alma', 'Amanda', 'Amber', 'Amelia', 'Amos', 'Amy',
  'Andrew', 'Angela', 'Angus', 'Anna', 'Annabel', 'Anne',
  'Anthony', 'Antonia', 'April', 'Archie', 'Arnold', 'Arthur',
  'Ashley', 'Astrid', 'Audrey', 'Augustus', 'Austin', 'Barbara',
  'Barnaby', 'Barry', 'Beatrice', 'Belinda', 'Benedict', 'Benjamin',
  'Bernard', 'Bertha', 'Beryl', 'Bethany', 'Betty', 'Beverley',
  'Bianca', 'Blake', 'Blanche', 'Bonnie', 'Brandon', 'Brenda',
  'Brian', 'Bridget', 'Bruce', 'Bryan', 'Callum', 'Calvin',
  'Cameron', 'Camilla', 'Carl', 'Carla', 'Carmen', 'Carol',
  'Caroline', 'Carter', 'Cassandra', 'Catherine', 'Cecil', 'Cecilia',
  'Cedric', 'Celia', 'Charles', 'Charlotte', 'Chloe', 'Christian',
  'Christine', 'Christopher', 'Clara', 'Clare', 'Clarence', 'Claude',
  'Claudia', 'Clifford', 'Clive', 'Colin', 'Connor', 'Constance',
  'Cora', 'Cordelia', 'Cornelius', 'Craig', 'Crispin', 'Cynthia',
  'Cyril', 'Daisy', 'Damian', 'Daniel', 'Danielle', 'Daphne',
  'Darren', 'David', 'Dawn', 'Deborah', 'Declan', 'Delia',
  'Denise', 'Dennis', 'Derek', 'Desmond', 'Diana', 'Diane',
  'Dilys', 'Dominic', 'Donald', 'Donna', 'Dora', 'Doreen',
  'Doris', 'Dorothy', 'Douglas', 'Duncan', 'Dylan', 'Edgar',
  'Edith', 'Edmund', 'Edna', 'Edward', 'Edwin', 'Eileen',
  'Elaine', 'Eleanor', 'Elias', 'Elijah', 'Elizabeth', 'Ella',
  'Ellen', 'Ellie', 'Elliot', 'Elsie', 'Emily', 'Emma',
  'Enid', 'Eric', 'Erica', 'Ernest', 'Esther', 'Ethan',
  'Ethel', 'Eugene', 'Eunice', 'Eva', 'Evelyn', 'Felicity',
  'Felix', 'Fergus', 'Fiona', 'Florence', 'Frances', 'Francis',
  'Frank', 'Franklin', 'Frederick', 'Freya', 'Gabriel', 'Gail',
  'Gareth', 'Gavin', 'Genevieve', 'Geoffrey', 'George', 'Georgia',
  'Gerald', 'Geraldine', 'Gerard', 'Gillian', 'Gladys', 'Glenda',
  'Gloria', 'Godfrey', 'Gordon', 'Grace', 'Graham', 'Grant',
  'Gregory', 'Greta', 'Gwendolyn', 'Hannah', 'Harold', 'Harriet',
  'Harry', 'Harvey', 'Hazel', 'Heather', 'Hector', 'Helen',
  'Helena', 'Henrietta', 'Henry', 'Herbert', 'Hilary', 'Hilda',
  'Holly', 'Honor', 'Horace', 'Howard', 'Hubert', 'Hugh',
  'Hugo', 'Humphrey', 'Ian', 'Ida', 'Imogen', 'Ingrid',
  'Irene', 'Iris', 'Isaac', 'Isabel', 'Isabella', 'Isadora',
  'Isla', 'Ivan', 'Ivy', 'Jack', 'Jacob', 'Jacqueline',
  'James', 'Jane', 'Janet', 'Janice', 'Jared', 'Jasmine',
  'Jason', 'Jasper', 'Jean', 'Jeffrey', 'Jemima', 'Jennifer',
  'Jeremy', 'Jerome', 'Jessica', 'Jill', 'Joan', 'Joanna',
  'Jocelyn', 'Joel', 'John', 'Jonathan', 'Jordan', 'Joseph',
  'Josephine', 'Joshua', 'Joyce', 'Judith', 'Julia', 'Julian',
  'Juliet', 'June', 'Justin', 'Karen', 'Katherine', 'Kathleen',
  'Keith', 'Kelly', 'Kenneth', 'Kevin', 'Kieran', 'Kirsty',
  'Kyle', 'Lachlan', 'Laura', 'Lauren', 'Laurence', 'Leah',
  'Lena', 'Leo', 'Leonard', 'Leslie', 'Lewis', 'Liam',
  'Lilian', 'Lily', 'Linda', 'Lionel', 'Lisa', 'Lloyd',
  'Logan', 'Lois', 'Lorna', 'Louis', 'Louise', 'Lucas',
  'Lucinda', 'Lucy', 'Luke', 'Lydia', 'Lyndon', 'Mabel',
  'Madeleine', 'Maggie', 'Malcolm', 'Marcus', 'Margaret', 'Marian',
  'Marilyn', 'Marion', 'Marjorie', 'Mark', 'Martha', 'Martin',
  'Mary', 'Mason', 'Matilda', 'Matthew', 'Maud', 'Maureen',
  'Maurice', 'Maxwell', 'Megan', 'Melanie', 'Melissa', 'Mercy',
  'Meredith', 'Merle', 'Mia', 'Michael', 'Michelle', 'Mildred',
  'Miles', 'Millicent', 'Miranda', 'Miriam', 'Mollie', 'Monica',
  'Morgan', 'Mortimer', 'Muriel', 'Murray', 'Myrtle', 'Nancy',
  'Naomi', 'Natalie', 'Nathan', 'Nathaniel', 'Neil', 'Nell',
  'Nelson', 'Nicholas', 'Nicola', 'Nigel', 'Nina', 'Noah',
  'Noel', 'Nora', 'Norman', 'Olive', 'Oliver', 'Olivia',
  'Ophelia', 'Orson', 'Oscar', 'Osmond', 'Oswald', 'Owen',
  'Paige', 'Pamela', 'Patience', 'Patricia', 'Patrick', 'Paul',
  'Paula', 'Pauline', 'Pearl', 'Peggy', 'Penelope', 'Percival',
  'Percy', 'Peter', 'Philip', 'Philippa', 'Phoebe', 'Phyllis',
  'Prudence', 'Quentin', 'Rachel', 'Ralph', 'Randolph', 'Raymond',
  'Rebecca', 'Reginald', 'Rhoda', 'Rhys', 'Richard', 'Rita',
  'Robert', 'Roberta', 'Robin', 'Roderick', 'Rodney', 'Roger',
  'Roland', 'Ronald', 'Rosalind', 'Rose', 'Rosemary', 'Rowena',
  'Ruby', 'Rupert', 'Russell', 'Ruth', 'Ryan', 'Sabrina',
  'Sally', 'Samantha', 'Samuel', 'Sandra', 'Sarah', 'Scarlett',
  'Scott', 'Sebastian', 'Selina', 'Seth', 'Sharon', 'Sheila',
  'Sidney', 'Silas', 'Simon', 'Sonia', 'Sophia', 'Sophie',
  'Stanley', 'Stella', 'Stephanie', 'Stephen', 'Steven', 'Stuart',
  'Susan', 'Susanna', 'Sybil', 'Sylvia', 'Tabitha', 'Tamsin',
  'Tara', 'Terence', 'Teresa', 'Thelma', 'Theodore', 'Thomas',
  'Tiffany', 'Timothy', 'Tobias', 'Toby', 'Trevor', 'Tristan',
  'Ursula', 'Valerie', 'Vanessa', 'Vera', 'Verity', 'Vernon',
  'Veronica', 'Victor', 'Victoria', 'Vincent', 'Viola', 'Violet',
  'Virginia', 'Vivian', 'Walter', 'Wanda', 'Warren', 'Wayne',
  'Wendy', 'Wesley', 'Wilbur', 'Wilfred', 'William', 'Willow',
  'Wilma', 'Winifred', 'Yolanda', 'Yvonne', 'Zachary', 'Zara',
  'Zoe',
] as const

/** English surname vocabulary. Bounded so callers can reason about capacity -- see
 *  {@link FIRST_NAMES} for why the bound is what it is. */
export const LAST_NAMES: readonly string[] = [
  'Abbott', 'Adams', 'Addison', 'Ainsworth', 'Albright', 'Alcott',
  'Alderman', 'Aldridge', 'Alexander', 'Allen', 'Allerton', 'Allison',
  'Alston', 'Anderson', 'Andrews', 'Appleby', 'Appleton', 'Archer',
  'Armitage', 'Armstrong', 'Arnold', 'Ashby', 'Ashcroft', 'Ashdown',
  'Asher', 'Ashford', 'Ashton', 'Ashworth', 'Atkins', 'Atkinson',
  'Attwood', 'Austen', 'Austin', 'Avery', 'Aylward', 'Babcock',
  'Bagley', 'Bailey', 'Bainbridge', 'Baird', 'Baker', 'Baldwin',
  'Ball', 'Ballard', 'Bancroft', 'Banks', 'Barber', 'Barclay',
  'Barker', 'Barlow', 'Barnard', 'Barnes', 'Barnett', 'Barrett',
  'Barrington', 'Barrow', 'Bartlett', 'Barton', 'Bassett', 'Bateman',
  'Bates', 'Baxter', 'Bayliss', 'Beaumont', 'Beckett', 'Bedford',
  'Belcher', 'Bell', 'Bellamy', 'Bellingham', 'Bennett', 'Benson',
  'Bentley', 'Benton', 'Beresford', 'Berkeley', 'Berry', 'Best',
  'Bevan', 'Bickford', 'Biggs', 'Billings', 'Bingham', 'Birch',
  'Bird', 'Bishop', 'Blackburn', 'Blackmore', 'Blackwood', 'Blair',
  'Blake', 'Blakely', 'Blanchard', 'Bland', 'Bliss', 'Bloom',
  'Blount', 'Blythe', 'Bolton', 'Bond', 'Bonner', 'Booker',
  'Boone', 'Booth', 'Borthwick', 'Boswell', 'Bosworth', 'Bottomley',
  'Boulton', 'Bourne', 'Bowden', 'Bowen', 'Bower', 'Bowles',
  'Bowman', 'Boyce', 'Boyd', 'Boyle', 'Bracken', 'Bradbury',
  'Bradford', 'Bradley', 'Bradshaw', 'Brady', 'Bragg', 'Braithwaite',
  'Bramley', 'Brandon', 'Bray', 'Brennan', 'Brett', 'Brewer',
  'Brewster', 'Bridges', 'Briggs', 'Bright', 'Brindley', 'Bristow',
  'Brock', 'Brockman', 'Bromley', 'Brook', 'Brooke', 'Brookes',
  'Brooks', 'Broome', 'Brotherton', 'Brough', 'Brown', 'Browne',
  'Browning', 'Bruce', 'Brunton', 'Bryant', 'Buchanan', 'Buckingham',
  'Buckland', 'Buckley', 'Budd', 'Bullock', 'Bunting', 'Burch',
  'Burgess', 'Burke', 'Burnett', 'Burns', 'Burrell', 'Burrows',
  'Burton', 'Bush', 'Butcher', 'Butler', 'Butterfield', 'Butterworth',
  'Byrne', 'Byron', 'Cadogan', 'Caldwell', 'Callaghan', 'Calvert',
  'Cameron', 'Campbell', 'Cannon', 'Carew', 'Carlisle', 'Carlton',
  'Carlyle', 'Carmichael', 'Carpenter', 'Carr', 'Carrington', 'Carroll',
  'Carson', 'Carter', 'Cartwright', 'Carver', 'Casey', 'Cash',
  'Cassidy', 'Castle', 'Caswell', 'Cavendish', 'Chadwick', 'Chalmers',
  'Chamberlain', 'Chambers', 'Champion', 'Chandler', 'Chapman', 'Charlton',
  'Chase', 'Chatfield', 'Cheshire', 'Chester', 'Chilton', 'Chisholm',
  'Christie', 'Church', 'Churchill', 'Clapham', 'Clark', 'Clarke',
  'Clayton', 'Cleary', 'Clegg', 'Clements', 'Clifford', 'Clifton',
  'Clough', 'Coates', 'Cobb', 'Cochrane', 'Cockburn', 'Coffey',
  'Colby', 'Cole', 'Coleman', 'Coles', 'Collier', 'Collingwood',
  'Collins', 'Colton', 'Colville', 'Compton', 'Conley', 'Connolly',
  'Conway', 'Cook', 'Cooke', 'Cookson', 'Coombs', 'Cooper',
  'Cope', 'Copeland', 'Corbett', 'Cornish', 'Cornwall', 'Cosgrove',
  'Cottrell', 'Coulson', 'Coulter', 'Courtney', 'Cousins', 'Coventry',
  'Coward', 'Cowell', 'Cowley', 'Cox', 'Coyle', 'Crabtree',
  'Craddock', 'Craig', 'Crane', 'Cranston', 'Craven', 'Crawford',
  'Crawley', 'Creighton', 'Cresswell', 'Crichton', 'Crisp', 'Crockett',
  'Croft', 'Cromwell', 'Crosby', 'Cross', 'Crossley', 'Crouch',
  'Crowther', 'Cullen', 'Culpepper', 'Cummings', 'Cunningham', 'Curran',
  'Currie', 'Curtis', 'Cushing', 'Dale', 'Dalton', 'Daly',
  'Danby', 'Daniels', 'Darby', 'Darling', 'Darnell', 'Davenport',
  'Davey', 'Davidson', 'Davies', 'Davis', 'Davison', 'Dawes',
  'Dawson', 'Deacon', 'Dean', 'Dempsey', 'Denham', 'Denning',
  'Dennison', 'Denton', 'Devlin', 'Dewar', 'Dewhurst', 'Dexter',
  'Dickens', 'Dickinson', 'Dickson', 'Digby', 'Dillon', 'Dixon',
  'Dobson', 'Docherty', 'Dodd', 'Dodson', 'Doherty', 'Donaldson',
  'Donnelly', 'Donovan', 'Doran', 'Dorsey', 'Doughty', 'Douglas',
  'Dover', 'Dowd', 'Dowling', 'Downes', 'Downing', 'Doyle',
  'Drake', 'Draper', 'Drew', 'Driscoll', 'Drummond', 'Duckworth',
  'Dudley', 'Duffield', 'Duffy', 'Dugdale', 'Duggan', 'Dunbar',
  'Duncan', 'Dundas', 'Dunlop', 'Dunn', 'Dunne', 'Durham',
  'Dutton', 'Dyer', 'Dyson', 'Eames', 'Earl', 'Easton',
  'Eastwood', 'Eaton', 'Eccles', 'Eddington', 'Edgerton', 'Edmonds',
  'Edmunds', 'Edwards', 'Egerton', 'Eldridge', 'Elliott', 'Ellis',
  'Ellison', 'Elmore', 'Elsworth', 'Elton', 'Elwood', 'Emerson',
  'Emery', 'English', 'Ennis', 'Erskine', 'Etherington', 'Evans',
  'Everett', 'Ewing', 'Fairbairn', 'Fairbanks', 'Fairchild', 'Fairclough',
  'Fairfax', 'Falconer', 'Fallon', 'Fanshawe', 'Faraday', 'Farley',
  'Farmer', 'Farnham', 'Farrell', 'Farrington', 'Faulkner', 'Fawcett',
  'Feeney', 'Fell', 'Fellows', 'Fenn', 'Fenton', 'Ferguson',
  'Field', 'Fielding', 'Finch', 'Findlay', 'Finlay', 'Finnegan',
  'Firth', 'Fisher', 'Fitzgerald', 'Fitzpatrick', 'Flanagan', 'Fleet',
  'Fleming', 'Fletcher', 'Flint', 'Flood', 'Flynn', 'Foley',
  'Forbes', 'Ford', 'Forrest', 'Forrester', 'Forster', 'Forsyth',
  'Fortescue', 'Foster', 'Fowler', 'Fox', 'Frampton', 'Francis',
  'Franklin', 'Fraser', 'Frazier', 'Freeman', 'French', 'Frost',
  'Fry', 'Fuller', 'Fulton', 'Furness', 'Gallagher', 'Galloway',
  'Gamble', 'Gannon', 'Gardiner', 'Gardner', 'Garland', 'Garner',
  'Garrett', 'Garrick', 'Garside', 'Garvey', 'Gaskell', 'Gates',
  'Geary', 'Gibbons', 'Gibbs', 'Gibson', 'Gilbert', 'Giles',
  'Gill', 'Gillespie', 'Gilmore', 'Gladstone', 'Glass', 'Gleeson',
  'Glover', 'Godfrey', 'Godwin', 'Golding', 'Goldsmith', 'Goodall',
  'Goodman', 'Goodwin', 'Gordon', 'Gore', 'Gormley', 'Gosling',
  'Gough', 'Gould', 'Gourlay', 'Graham', 'Grainger', 'Grange',
  'Grant', 'Graves', 'Gray', 'Grayson', 'Greaves', 'Green',
  'Greenaway', 'Greene', 'Greenfield', 'Greenhalgh', 'Greenwood', 'Greer',
  'Gregg', 'Gregory', 'Grenville', 'Gresham', 'Grey', 'Grierson',
  'Griffin', 'Griffith', 'Griffiths', 'Grimes', 'Grimshaw', 'Grosvenor',
  'Grove', 'Groves', 'Guest', 'Gunn', 'Guthrie', 'Hackett',
  'Hadley', 'Haig', 'Haines', 'Hale', 'Hales', 'Halford',
  'Hall', 'Hallam', 'Halliday', 'Halliwell', 'Hamilton', 'Hammond',
  'Hampson', 'Hampton', 'Hancock', 'Hand', 'Handley', 'Hanley',
  'Hanna', 'Hannay', 'Hanson', 'Harding', 'Hardwick', 'Hardy',
  'Hargreaves', 'Harkness', 'Harland', 'Harley', 'Harlow', 'Harman',
  'Harper', 'Harrington', 'Harris', 'Harrison', 'Hart', 'Hartley',
  'Harvey', 'Harwood', 'Haslam', 'Hastings', 'Hatfield', 'Hathaway',
  'Hawker', 'Hawkes', 'Hawkins', 'Hawley', 'Hawthorne', 'Hay',
  'Haydon', 'Hayes', 'Hayward', 'Haywood', 'Head', 'Healey',
  'Heath', 'Heathcote', 'Hedley', 'Hemmings', 'Henderson', 'Hendry',
  'Henley', 'Henshaw', 'Hepburn', 'Herbert', 'Heron', 'Herrick',
  'Hetherington', 'Hewitt', 'Heywood', 'Hibbert', 'Hickey', 'Hicks',
  'Higgins', 'Hill', 'Hilliard', 'Hilton', 'Hinchcliffe', 'Hindley',
  'Hinton', 'Hirst', 'Hitchcock', 'Hobbs', 'Hobson', 'Hodge',
  'Hodges', 'Hodgkinson', 'Hodgson', 'Hogan', 'Hogg', 'Holbrook',
  'Holcroft', 'Holden', 'Holder', 'Holdsworth', 'Holland', 'Hollingworth',
  'Hollis', 'Holloway', 'Holmes', 'Holt', 'Hood', 'Hooper',
  'Hope', 'Hopkins', 'Hopper', 'Horne', 'Horner', 'Horsley',
  'Horton', 'Hoskins', 'Houghton', 'Houston', 'Howard', 'Howarth',
  'Howe', 'Howell', 'Howells', 'Howes', 'Hoyle', 'Hubbard',
  'Huddleston', 'Hudson', 'Huggins', 'Hughes', 'Hulme', 'Hume',
  'Humphrey', 'Humphreys', 'Humphries', 'Hunt', 'Hunter', 'Huntington',
  'Hurley', 'Hurst', 'Hussey', 'Hutchinson', 'Hutton', 'Huxley',
  'Hyde', 'Illingworth', 'Ingham', 'Ingram', 'Inman', 'Ireland',
  'Irvine', 'Irving', 'Irwin', 'Isherwood', 'Jackson', 'Jacobs',
  'James', 'Jameson', 'Jarvis', 'Jefferson', 'Jeffries', 'Jenkins',
  'Jennings', 'Jessop', 'Jewell', 'Johns', 'Johnson', 'Johnston',
  'Johnstone', 'Jolly', 'Jones', 'Jordan', 'Joyce', 'Judd',
  'Kane', 'Kavanagh', 'Kay', 'Kaye', 'Keane', 'Kearney',
  'Keating', 'Keeble', 'Keeling', 'Keen', 'Keene', 'Kellett',
  'Kelly', 'Kemp', 'Kendall', 'Kennedy', 'Kenny', 'Kent',
  'Kenworthy', 'Keogh', 'Kerr', 'Kerrigan', 'Kershaw', 'Kettle',
  'Kidd', 'Kilburn', 'Kimber', 'King', 'Kingsley', 'Kingston',
  'Kinsella', 'Kirby', 'Kirk', 'Kirkland', 'Kirkpatrick', 'Kitchen',
  'Knapp', 'Knight', 'Knowles', 'Knox', 'Lacey', 'Laidlaw',
  'Laing', 'Lake', 'Lamb', 'Lambert', 'Lancaster', 'Landon',
  'Lane', 'Langdon', 'Langford', 'Langley', 'Langton', 'Larkin',
  'Latham', 'Lavender', 'Law', 'Lawler', 'Lawrence', 'Lawson',
  'Lawton', 'Layton', 'Lea', 'Leach', 'Leahy', 'Leary',
  'Ledger', 'Lee', 'Leech', 'Legge', 'Leigh', 'Leighton',
  'Lennon', 'Lennox', 'Leonard', 'Leslie', 'Lester', 'Levy',
  'Lewis', 'Liddell', 'Lightfoot', 'Lilley', 'Lincoln', 'Lindley',
  'Lindsay', 'Linton', 'Little', 'Littlewood', 'Lloyd', 'Locke',
  'Lockhart', 'Lockwood', 'Logan', 'Lomax', 'Long', 'Longley',
  'Lonsdale', 'Lord', 'Lovell', 'Lowe', 'Lowell', 'Lowry',
  'Lucas', 'Ludlow', 'Lumley', 'Lund', 'Lunn', 'Lynch',
  'Lyons', 'Macdonald', 'Mackay', 'Mackenzie', 'Mackie', 'Mackintosh',
  'Maclean', 'Macleod', 'Madden', 'Maddox', 'Magee', 'Maguire',
  'Mahoney', 'Mallory', 'Malone', 'Maloney', 'Mann', 'Manning',
  'Mansell', 'Mansfield', 'Marchant', 'Marks', 'Marlow', 'Marlowe',
  'Marsden', 'Marsh', 'Marshall', 'Marston', 'Martin', 'Martindale',
  'Mason', 'Massey', 'Masters', 'Mather', 'Mathews', 'Matthews',
  'Maxwell', 'May', 'Maynard', 'Mayo', 'McBride', 'McCabe',
  'McCarthy', 'McCormick', 'McDermott', 'McDonald', 'McDowell', 'McGrath',
  'McGregor', 'McGuire', 'McIntyre', 'McKay', 'McKenna', 'McKinley',
  'McLaughlin', 'McMahon', 'McManus', 'McNeill', 'Meadows', 'Melton',
  'Mercer', 'Meredith', 'Merrick', 'Merrill', 'Merritt', 'Metcalf',
  'Metcalfe', 'Middleton', 'Milburn', 'Miles', 'Millard', 'Miller',
  'Milligan', 'Mills', 'Milne', 'Milner', 'Milton', 'Mitchell',
  'Moffatt', 'Molloy', 'Monaghan', 'Monk', 'Montgomery', 'Moody',
  'Moon', 'Mooney', 'Moore', 'Moran', 'Morgan', 'Morley',
  'Morrell', 'Morris', 'Morrison', 'Morrow', 'Morse', 'Mortimer',
  'Morton', 'Moss', 'Mountford', 'Mowbray', 'Muir', 'Mullen',
  'Mulligan', 'Mullins', 'Mumford', 'Munro', 'Murdoch', 'Murphy',
  'Murray', 'Myers', 'Napier', 'Nash', 'Naylor', 'Neal',
  'Neale', 'Needham', 'Neville', 'Newby', 'Newell', 'Newman',
  'Newton', 'Nicholls', 'Nichols', 'Nicholson', 'Nixon', 'Noble',
  'Nolan', 'Norman', 'Norris', 'North', 'Northcote', 'Norton',
  'Norwood', 'Nugent', 'Nunn', 'Nuttall', 'Oakes', 'Oakley',
  'Oldfield', 'Oldham', 'Oliver', 'Ormerod', 'Ormsby', 'Orr',
  'Osborne', 'Osgood', 'Overton', 'Owen', 'Owens', 'Oxley',
  'Packer', 'Padgett', 'Page', 'Paget', 'Paine', 'Painter',
  'Palmer', 'Parish', 'Park', 'Parker', 'Parkes', 'Parkin',
  'Parkinson', 'Parr', 'Parrish', 'Parry', 'Parsons', 'Partridge',
  'Pascoe', 'Patel', 'Paterson', 'Patterson', 'Pattison', 'Paxton',
  'Payne', 'Peacock', 'Peake', 'Pearce', 'Pearson', 'Pease',
  'Peck', 'Peel', 'Pemberton', 'Pembroke', 'Pendleton', 'Penn',
  'Pennington', 'Penrose', 'Perkins', 'Perry', 'Peters', 'Petersen',
  'Pettigrew', 'Phelps', 'Phillips', 'Philpott', 'Pickering', 'Pickett',
  'Pierce', 'Pigott', 'Pike', 'Pilkington', 'Pinkerton', 'Piper',
  'Pitcher', 'Pitman', 'Pitt', 'Platt', 'Plummer', 'Pollard',
  'Pollock', 'Ponsonby', 'Poole', 'Pope', 'Porter', 'Postlethwaite',
  'Potter', 'Potts', 'Poulton', 'Powell', 'Power', 'Pratt',
  'Prescott', 'Preston', 'Price', 'Prichard', 'Priestley', 'Primrose',
  'Prince', 'Pringle', 'Prior', 'Pritchard', 'Proctor', 'Prosser',
  'Pryce', 'Pugh', 'Pullman', 'Purcell', 'Purdy', 'Pye',
  'Quigley', 'Quinn', 'Radcliffe', 'Radford', 'Rae', 'Raeburn',
  'Ramsay', 'Ramsey', 'Randall', 'Rankin', 'Ransom', 'Ratcliffe',
  'Rawlings', 'Rawlinson', 'Rawson', 'Ray', 'Rayner', 'Read',
  'Reade', 'Reading', 'Redfern', 'Redgrave', 'Redman', 'Redmond',
  'Reed', 'Rees', 'Reeves', 'Reid', 'Rendell', 'Rennie',
  'Reynolds', 'Rhodes', 'Rice', 'Rich', 'Richards', 'Richardson',
  'Richmond', 'Riddell', 'Rider', 'Ridley', 'Rigby', 'Riley',
  'Rimmer', 'Ripley', 'Ritchie', 'Rivers', 'Roach', 'Robb',
  'Roberts', 'Robertson', 'Robinson', 'Robson', 'Roche', 'Rodgers',
  'Roe', 'Rogers', 'Rollins', 'Rooney', 'Roper', 'Rose',
  'Ross', 'Rossiter', 'Rothwell', 'Rourke', 'Rowan', 'Rowe',
  'Rowell', 'Rowland', 'Rowley', 'Rowntree', 'Royce', 'Royle',
  'Rudd', 'Rushton', 'Russell', 'Rutherford', 'Rutledge', 'Ryan',
  'Ryder', 'Sadler', 'Salisbury', 'Salmon', 'Salter', 'Sampson',
  'Sanders', 'Sanderson', 'Sandford', 'Sargent', 'Saunders', 'Savage',
  'Sawyer', 'Saxon', 'Sayers', 'Scarborough', 'Schofield', 'Scott',
  'Scrivener', 'Searle', 'Sears', 'Seaton', 'Sedgwick', 'Selby',
  'Sellars', 'Selwyn', 'Sewell', 'Sexton', 'Seymour', 'Shackleton',
  'Shannon', 'Sharp', 'Sharpe', 'Shaw', 'Shea', 'Shearer',
  'Sheldon', 'Shelley', 'Shelton', 'Shepherd', 'Sheppard', 'Sheridan',
  'Sherlock', 'Sherman', 'Sherwood', 'Shields', 'Shipley', 'Shipton',
  'Short', 'Sibley', 'Silver', 'Simmonds', 'Simmons', 'Simms',
  'Simpson', 'Sims', 'Sinclair', 'Skelton', 'Skinner', 'Slade',
  'Slater', 'Sloane', 'Small', 'Smart', 'Smedley', 'Smith',
  'Smithson', 'Smyth', 'Snell', 'Snow', 'Snowden', 'Somers',
  'Somerset', 'Somerville', 'Southgate', 'Sowerby', 'Spalding', 'Sparks',
  'Sparrow', 'Spence', 'Spencer', 'Spicer', 'Spooner', 'Squires',
  'Stacey', 'Stafford', 'Standish', 'Stanfield', 'Stanford', 'Stanhope',
  'Stanley', 'Stanton', 'Staples', 'Stark', 'Starkey', 'Statham',
  'Stead', 'Steel', 'Steele', 'Stephens', 'Stephenson', 'Sterling',
  'Stevens', 'Stevenson', 'Steward', 'Stewart', 'Stiles', 'Stirling',
  'Stockton', 'Stoddart', 'Stokes', 'Stone', 'Storey', 'Stott',
  'Strachan', 'Strange', 'Stratton', 'Street', 'Stringer', 'Strong',
  'Stuart', 'Stubbs', 'Sullivan', 'Summers', 'Sumner', 'Sutcliffe',
  'Sutherland', 'Sutton', 'Swain', 'Swan', 'Swann', 'Sweeney',
  'Swift', 'Sykes', 'Symonds', 'Talbot', 'Tanner', 'Tarrant',
  'Tate', 'Taylor', 'Temple', 'Templeton', 'Tennant', 'Terry',
  'Thacker', 'Thackeray', 'Thatcher', 'Thomas', 'Thompson', 'Thomson',
  'Thorburn', 'Thorne', 'Thornhill', 'Thornley', 'Thornton', 'Thorpe',
  'Thurlow', 'Thwaites', 'Tierney', 'Tilley', 'Timms', 'Tindall',
  'Tinsley', 'Tobin', 'Todd', 'Tomkins', 'Tomlinson', 'Tonkin',
  'Topping', 'Torrance', 'Tovey', 'Townsend', 'Travers', 'Travis',
  'Treloar', 'Tremaine', 'Trent', 'Trevelyan', 'Trimble', 'Tripp',
  'Trotter', 'Troughton', 'Trowbridge', 'Truman', 'Tucker', 'Tudor',
  'Tunnicliffe', 'Turnbull', 'Turner', 'Turpin', 'Tweedie', 'Twigg',
  'Twining', 'Tyler', 'Tyrrell', 'Tyson', 'Underhill', 'Underwood',
  'Unwin', 'Upton', 'Urquhart', 'Usher', 'Vale', 'Valentine',
  'Vance', 'Vane', 'Varley', 'Vaughan', 'Veitch', 'Venables',
  'Vernon', 'Vickers', 'Vickery', 'Villiers', 'Vincent', 'Vine',
  'Wade', 'Wadsworth', 'Wainwright', 'Waite', 'Wakefield', 'Waldron',
  'Wales', 'Walford', 'Walker', 'Wall', 'Wallace', 'Waller',
  'Wallis', 'Walmsley', 'Walpole', 'Walsh', 'Walters', 'Walton',
  'Warburton', 'Ward', 'Ware', 'Waring', 'Warner', 'Warren',
  'Warrington', 'Warwick', 'Waterhouse', 'Waterman', 'Waters', 'Watkins',
  'Watson', 'Watt', 'Watts', 'Waugh', 'Weaver', 'Webb',
  'Webber', 'Webster', 'Weeks', 'Welch', 'Weller', 'Wells',
  'Welsh', 'West', 'Westbrook', 'Westcott', 'Weston', 'Whalley',
  'Wharton', 'Wheatley', 'Wheeler', 'Whelan', 'Whitaker', 'Whitby',
  'White', 'Whitehead', 'Whitehouse', 'Whitelaw', 'Whiteside', 'Whitfield',
  'Whiting', 'Whitley', 'Whitlock', 'Whitmore', 'Whitney', 'Whittaker',
  'Whittington', 'Whittle', 'Whitworth', 'Wickham', 'Wiggins', 'Wilcox',
  'Wilde', 'Wilding', 'Wilkes', 'Wilkins', 'Wilkinson', 'Willard',
  'Willetts', 'Williams', 'Williamson', 'Willis', 'Willoughby', 'Wills',
  'Wilmot', 'Wilson', 'Wilton', 'Winchester', 'Windsor', 'Winfield',
  'Wingate', 'Winn', 'Winslow', 'Winstanley', 'Winston', 'Winter',
  'Winterbourne', 'Winters', 'Winton', 'Wise', 'Wiseman', 'Withers',
  'Witherspoon', 'Wolfe', 'Wood', 'Woodall', 'Woodbridge', 'Woodcock',
  'Woodhouse', 'Woodley', 'Woodruff', 'Woods', 'Woodward', 'Woolley',
  'Worth', 'Worthington', 'Wragg', 'Wray', 'Wren', 'Wright',
  'Wrigley', 'Wyatt', 'Wynne', 'Yardley', 'Yates', 'Yeats',
  'Yeo', 'York', 'Young', 'Younger',
] as const

/**
 * Unbiased index via rejection sampling.
 *
 * Modulo reduction (`v % n`) is biased when `2^32` is not divisible by `n`: the
 * first `(2^32 % n)` remainders are drawn one extra time. Rejection sampling
 * eliminates the bias by discarding any Uint32 that falls in the "tail"
 * `[limit, 2^32)` where `limit = 2^32 - (2^32 % n)`, then reducing the accepted
 * value. The expected number of draws is less than 2 for all `n <= 2^31`.
 *
 * Exported as a pure seam so tests can verify retry behaviour by injecting a
 * controlled `getUint32` sequence -- no mock of `crypto` needed, and no
 * test-only production API.
 *
 * The bound is CHECKED, because this is exported and the bound is therefore an argument rather
 * than an internal invariant (low-cost final-review minor). `upperExclusive = 0` made
 * `4294967296 % 0` be `NaN`, so `limit` was `NaN`, `v < NaN` was always false, and this
 * function spun forever on a CPU with nothing to distinguish it from a hang. A negative or
 * fractional bound is the same bug with a quieter symptom: a plausible-looking index outside the
 * array it is about to index.
 */
export function unbiasedIndex(getUint32: () => number, upperExclusive: number): number {
  // 4294967296 = 2^32, safely representable as a JS number (< 2^53 - 1). A bound ABOVE it cannot
  // be sampled without bias from one 32-bit draw, which is the one thing this function exists to
  // avoid, so it is refused rather than silently approximated.
  if (!Number.isInteger(upperExclusive) || upperExclusive < 1 || upperExclusive > 4294967296) {
    throw new Error(
      `unbiasedIndex: the bound must be a positive integer no larger than 2^32; got ${String(upperExclusive)}`,
    )
  }
  const limit = 4294967296 - (4294967296 % upperExclusive)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = getUint32()
    if (v < limit) return v % upperExclusive
  }
}

/** Cryptographic random index using rejection sampling, used as the production default. */
function cryptoRandomIndex(upperExclusive: number): number {
  const array = new Uint32Array(1)
  return unbiasedIndex(() => {
    crypto.getRandomValues(array)
    // biome-ignore lint/style/noNonNullAssertion: array always has one element
    return array[0]!
  }, upperExclusive)
}

/**
 * Generate a random English name: one first name and one surname from the bounded
 * dictionaries, separated by exactly one space.
 *
 * @param randomIndex - injectable randomness; defaults to cryptographic random.
 *   Called with the upper-exclusive bound and must return an integer in [0, bound).
 */
export function randomEnglishName(
  randomIndex: (upperExclusive: number) => number = cryptoRandomIndex,
): string {
  const first = FIRST_NAMES[randomIndex(FIRST_NAMES.length)]
  const last = LAST_NAMES[randomIndex(LAST_NAMES.length)]
  return `${first} ${last}`
}

const FIRST_NAME_SET = new Set<string>(FIRST_NAMES)
const LAST_NAME_SET = new Set<string>(LAST_NAMES)

/**
 * Return true iff `value` is a string that could have been produced by
 * {@link randomEnglishName}: exactly two words separated by one space, where
 * the first word is in {@link FIRST_NAMES} and the second is in {@link LAST_NAMES}.
 */
export function isGeneratedEnglishName(value: string): boolean {
  const spaceIndex = value.indexOf(' ')
  if (spaceIndex === -1) return false
  const first = value.slice(0, spaceIndex)
  const last = value.slice(spaceIndex + 1)
  // Ensure there is exactly one space (no double spaces, no trailing spaces)
  if (last.includes(' ')) return false
  return FIRST_NAME_SET.has(first) && LAST_NAME_SET.has(last)
}
